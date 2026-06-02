export type KeyedAsyncQueueHooks = {
  /** Called synchronously when the task is added, before it waits on any prior tail. */
  onEnqueue?: () => void;
  /** Called once the task promise settles, before the per-key tail cleanup runs. */
  onSettle?: () => void;
};

/** Serialize async work per key while allowing unrelated keys to run concurrently. */
export function enqueueKeyedTask<T>(params: {
  /** Shared per-key tail map; callers may provide their own map to observe or shard queues. */
  tails: Map<string, Promise<void>>;
  /** Serialization key. Tasks with the same key run in enqueue order. */
  key: string;
  /** Work to run after the previous task for this key has settled. */
  task: () => Promise<T>;
  hooks?: KeyedAsyncQueueHooks;
}): Promise<T> {
  params.hooks?.onEnqueue?.();
  const previous = params.tails.get(params.key) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(params.task)
    .finally(() => {
      params.hooks?.onSettle?.();
    });
  // Store a void tail that absorbs the task outcome so later tasks still run and Node does
  // not report an unhandled rejection for the queue bookkeeping promise.
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  params.tails.set(params.key, tail);
  const cleanup = () => {
    // Only the newest tail for a key owns deletion; this preserves a later enqueue that
    // replaced the map entry while an older task was still settling.
    if (params.tails.get(params.key) === tail) {
      params.tails.delete(params.key);
    }
  };
  tail.then(cleanup, cleanup);
  return current;
}

/** Small reusable per-key async queue for SDK consumers that do not need a custom tail map. */
export class KeyedAsyncQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /** Expose live tails for narrow tests and diagnostics without making queue state mutable API. */
  getTailMapForTesting(): Map<string, Promise<void>> {
    return this.tails;
  }

  /** Enqueue work behind the current tail for `key`, preserving the task's result or error. */
  enqueue<T>(key: string, task: () => Promise<T>, hooks?: KeyedAsyncQueueHooks): Promise<T> {
    return enqueueKeyedTask({
      tails: this.tails,
      key,
      task,
      ...(hooks ? { hooks } : {}),
    });
  }
}
