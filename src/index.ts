import {DevToolEnabledSource} from '@cycle/run';
import xs, {Stream, MemoryStream, InternalListener, OutSender, Operator} from 'xstream';
import dropRepeats from 'xstream/extra/dropRepeats';
import isolate from '@cycle/isolate';
import {adapt} from '@cycle/run/lib/adapt';
export {pickCombine} from './pickCombine';
export {pickMerge} from './pickMerge';

export type MainFn<So, Si> = (sources: So) => Si;
export type Reducer<T> = (state: T | undefined) => T | undefined;
export type Getter<T, R> = (state: T | undefined) => R | undefined;
export type Setter<T, R> = (state: T | undefined, childState: R | undefined) => T | undefined;
export type Lens<T, R> = {
  get: Getter<T, R>;
  set: Setter<T, R>;
};
export type Scope<T, R> = string | number | Lens<T, R>;
export type Instances<Si> = {
  dict: any,
  arr: Array<Si & {_key: string}>,
};

function onionifyChild(childComp: any): any {
  return function childOnionified(sources: any): any {
    const reducerMimic$ = xs.create<Reducer<any>>();
    const reducerFromParentState$: Stream<Reducer<any>> = sources.onion.state$
      .map((state: any) => () => state);

    const state$: Stream<any> = xs.merge(reducerMimic$, reducerFromParentState$)
      .fold((state, reducer) => reducer(state), void 0)
      .drop(1)
      .filter(s => typeof s !== 'undefined');

    sources.onion = new StateSource<any>(state$, 'onion') as any;
    const sinks = childComp(sources);
    if (sinks.onion) {
      const stream$ = xs.fromObservable<Reducer<any>>(sinks.onion);
      reducerMimic$.imitate(stream$);

      const reducerToParent$ = state$.map((state: any) => () => state);
      return {...sinks, onion: reducerToParent$};
    } else {
      return sinks;
    }
  };
}

function defaultGetKey(statePiece: any) {
  return statePiece.key;
}

function instanceLens(key: string): Lens<Array<any>, any> {
  return  {
    get(arr: Array<any> | undefined): any {
      if (typeof arr === 'undefined') {
        return void 0;
      } else {
        for (let i = 0, n = arr.length; i < n; ++i) {
          if (arr[i].key === key) {
            return arr[i];
          }
        }
        return void 0;
      }
    },

    set(arr: Array<any> | undefined, item: any): any {
      if (typeof arr === 'undefined') {
        return [item];
      } else if (typeof item === 'undefined') {
        return arr.filter(s => s.key !== key);
      } else {
        return arr.map(s => {
          if (s.key === key) {
            return item;
          } else {
            return s;
          }
        });
      }
    },
  };
}

export function collection<Si>(itemComp: (so: any) => Si,
                               sources: any,
                               getKey: any = defaultGetKey): Stream<Instances<Si>> {
  const array$ = sources.onion.state$;

  const collection$ = array$.fold((acc: Instances<Si>, nextStateArray: any) => {
    const dict = acc.dict;
    const nextInstArray = Array(nextStateArray.length) as Array<Si & {_key: string}>;

    const nextKeys = {};
    // add
    for (let i = 0, n = nextStateArray.length; i < n; ++i) {
      const key = getKey(nextStateArray[i]);
      nextKeys[key] = true;
      if (!(key in dict)) {
        const scopes = {'*': '$c$' + i, onion: instanceLens(key)};
        dict[key] = isolate(onionifyChild(itemComp), scopes)(sources);
      }
      nextInstArray[i] = dict[key];
      nextInstArray[i]._key = key;
    }
    // remove
    for (const key in dict) {
      if (!(key in nextKeys)) {
        delete dict[key];
      }
    }
    return {dict: dict, arr: nextInstArray};
  }, {dict: {}, arr: []} as Instances<Si>);

  return collection$;
}

function makeGetter<T, R>(scope: Scope<T, R>): Getter<T, R> {
  if (typeof scope === 'string' || typeof scope === 'number') {
    return function lensGet(state) {
      if (typeof state === 'undefined') {
        return void 0;
      } else {
        return state[scope];
      }
    };
  } else {
    return scope.get;
  }
}

function makeSetter<T, R>(scope: Scope<T, R>): Setter<T, R> {
  if (typeof scope === 'string' || typeof scope === 'number') {
    return function lensSet(state: T, childState: R): T {
      if (Array.isArray(state)) {
        return updateArrayEntry(state, scope, childState) as any;
      } else if (typeof state === 'undefined') {
        return {[scope]: childState} as any as T;
      } else {
        return {...(state as any), [scope]: childState};
      }
    };
  } else {
    return scope.set;
  }
}

function updateArrayEntry<T>(array: Array<T>, scope: number | string, newVal: any): Array<T> {
  if (newVal === array[scope]) {
    return array;
  }
  const index = parseInt(scope as string);
  if (typeof newVal === 'undefined') {
    return array.filter((val, i) => i !== index);
  }
  return array.map((val, i) => i === index ? newVal : val);
}

export function isolateSource<T, R>(
                             source: StateSource<T>,
                             scope: Scope<T, R>): StateSource<R> {
  return source.select(scope);
}

export function isolateSink<T, R>(
                           innerReducer$: Stream<Reducer<R>>,
                           scope: Scope<T, R>): Stream<Reducer<T>> {
  const get = makeGetter(scope);
  const set = makeSetter(scope);

  return innerReducer$
    .map(innerReducer => function outerReducer(outer: T | undefined) {
      const prevInner = get(outer);
      const nextInner = innerReducer(prevInner);
      if (prevInner === nextInner) {
        return outer;
      } else {
        return set(outer, nextInner);
      }
    });
}

export class StateSource<T> {
  public state$: MemoryStream<T>;
  private _state$: MemoryStream<T>;
  private _name: string | null;

  constructor(stream: Stream<any>, name: string | null) {
    this._name = name;
    this._state$ = stream.compose(dropRepeats()).remember()
    this.state$ = adapt(this._state$);
    if (!name) {
      return;
    }
    (this._state$ as MemoryStream<T> & DevToolEnabledSource)._isCycleSource = name;
  }

  public select<R>(scope: Scope<T, R>): StateSource<R> {
    const get = makeGetter(scope);
    return new StateSource<R>(
      this._state$.map(get).filter(s => typeof s !== 'undefined'),
      null,
    );
  }

  public isolateSource = isolateSource;
  public isolateSink = isolateSink;
}

export default function onionify<So, Si>(
                                main: MainFn<So, Si>,
                                name: string = 'onion'): MainFn<Partial<So>, Partial<Si>> {
  return function mainOnionified(sources: Partial<So>): Partial<Si> {
    const reducerMimic$ = xs.create<Reducer<any>>();
    const state$ = reducerMimic$
      .fold((state, reducer) => reducer(state), void 0)
      .drop(1);
    sources[name as any] = new StateSource<any>(state$, name) as any;
    const sinks = main(sources as So);
    if (sinks[name]) {
      const stream$ = xs.fromObservable<Reducer<any>>(sinks[name]);
      reducerMimic$.imitate(stream$);
    }
    return sinks;
  };
}
