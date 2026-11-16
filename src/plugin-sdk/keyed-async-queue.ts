// Keyed async queue helpers serialize async plugin work by key while preserving parallelism.
/** Optional lifecycle hooks fired around each queued task. */
export type KeyedAsyncQueueHooks = {
  onEnqueue?: () => void;
  onSettle?: () => void;
};

type KeyedAsyncTask<T, TKey> = {
  tails: {
    get(key: TKey): Promise<unknown> | undefined;
    set(key: TKey, tail: Promise<void>): unknown;
    delete(key: TKey): boolean;
  };
  task: () => Promise<T>;
  hooks?: KeyedAsyncQueueHooks;
} & ({ key: TKey } | { keys: readonly TKey[] });

/** Reserve every task key before yielding; unrelated keys remain independent. */
export function enqueueKeyedTask<T, TKey>(params: KeyedAsyncTask<T, TKey>): Promise<T>;
export function enqueueKeyedTask<T>(params: {
  tails: Map<string, Promise<void>>;
  key: string;
  task: () => Promise<T>;
  hooks?: KeyedAsyncQueueHooks;
}): Promise<T>;
export function enqueueKeyedTask<T, TKey>(params: KeyedAsyncTask<T, TKey>): Promise<T> {
  params.hooks?.onEnqueue?.();
  const keys = "keys" in params ? params.keys : [params.key];
  const previous =
    "keys" in params
      ? Promise.allSettled(keys.map((key) => params.tails.get(key) ?? Promise.resolve()))
      : (params.tails.get(params.key) ?? Promise.resolve()).catch(() => undefined);
  const current = previous.then(params.task).finally(() => {
    params.hooks?.onSettle?.();
  });
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  for (const key of keys) {
    params.tails.set(key, tail);
  }
  const cleanup = () => {
    for (const key of keys) {
      if (params.tails.get(key) === tail) {
        params.tails.delete(key);
      }
    }
  };
  tail.then(cleanup, cleanup);
  return current;
}

/** Small per-key async queue wrapper for plugin runtimes that need serialized work. */
export class KeyedAsyncQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * @deprecated Retained for shipped Plugin SDK compatibility. New callers must
   * not depend on queue storage; remove in a declared Plugin SDK breaking window.
   */
  getTailMapForTesting(): Map<string, Promise<void>> {
    return this.tails;
  }

  enqueue<T>(key: string, task: () => Promise<T>, hooks?: KeyedAsyncQueueHooks): Promise<T> {
    return enqueueKeyedTask({
      tails: this.tails,
      key,
      task,
      ...(hooks ? { hooks } : {}),
    });
  }
}
