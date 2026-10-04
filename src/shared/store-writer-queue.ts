import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createDeferredCore } from "./deferred.js";
import { resolveGlobalSingleton } from "./global-singleton.js";

const MAX_WRITERS_PER_TURN = 4;
const WRITER_TURN_BUDGET_MS = 4;

type StoreWriterTask = {
  keys?: ReadonlySet<string>;
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

/** Conflicting writes remain FIFO; an unkeyed write excludes the entire store. */
export type StoreWriterQueue = {
  pending: StoreWriterTask[];
  drainPromise: Promise<void> | null;
  wake?: () => void;
};

/** Store writer queues keyed by the canonical store path. */
type StoreWriterQueues = Map<string, StoreWriterQueue>;

/** Request-owned monotonic timestamps; queued work may be rejected without entering. */
export type StoreWriterTiming = { startedAt?: number; finishedAt?: number; reentrant?: boolean };

type ActiveStoreWriter = {
  active: boolean;
  parent: ActiveStoreWriter | undefined;
  queues: StoreWriterQueues;
  storePath: string;
  keys?: ReadonlySet<string>;
};

// Queue maps are often global singletons shared by separately bundled runtime
// chunks. Their reentrancy context must cross the same module boundary.
const activeStoreWriters = resolveGlobalSingleton(
  Symbol.for("openclaw.activeStoreWriters"),
  () => new AsyncLocalStorage<ActiveStoreWriter>(),
);

// Independently draining stores share one event loop, including separately bundled callers.
const writerTurn = resolveGlobalSingleton(
  Symbol.for("openclaw.storeWriterTurn"),
  (): {
    started: number;
    startedAt: number;
    reset: Promise<void> | undefined;
    wait: Promise<void> | undefined;
  } => ({
    started: 0,
    startedAt: 0,
    reset: undefined,
    wait: undefined,
  }),
);

function claimStoreWriterTurn(immediate: boolean): Promise<void> | undefined {
  const now = performance.now();
  if (!writerTurn.reset) {
    writerTurn.started = 0;
    writerTurn.startedAt = now;
    writerTurn.reset = nextTurn().then(() => {
      writerTurn.reset = undefined;
    });
  }
  // Idle first writers retain synchronous acquisition; their work still consumes the turn.
  if (
    !immediate &&
    (writerTurn.wait ||
      writerTurn.started >= MAX_WRITERS_PER_TURN ||
      now - writerTurn.startedAt >= WRITER_TURN_BUDGET_MS)
  ) {
    // The reset can precede I/O queued during this turn. Yield from exhaustion, not its start.
    return (writerTurn.wait ??= nextTurn().then(() => {
      writerTurn.wait = undefined;
    }));
  }
  writerTurn.started++;
  return undefined;
}

export function isActiveStoreWriter(
  queues: StoreWriterQueues,
  storePath: string,
  keys?: ReadonlySet<string>,
): boolean {
  // A new lane cannot be reentrant; bulk acquisition must not scan every held lock.
  if (!queues.has(storePath)) {
    return false;
  }
  let active = activeStoreWriters.getStore();
  while (active) {
    if (active.active && active.queues === queues && active.storePath === storePath) {
      const heldKeys = active.keys;
      if (heldKeys && (!keys || [...keys].some((key) => !heldKeys.has(key)))) {
        throw new Error("Cannot expand an active store writer's keys");
      }
      return true;
    }
    active = active.parent;
  }
  return false;
}

async function runActiveStoreWriter<T>(
  queues: StoreWriterQueues,
  storePath: string,
  fn: () => Promise<T>,
  timing?: StoreWriterTiming,
  keys?: ReadonlySet<string>,
): Promise<T> {
  const writer = { active: true, parent: activeStoreWriters.getStore(), queues, storePath, keys };
  if (timing) {
    timing.reentrant = false;
    timing.startedAt = performance.now();
  }
  try {
    return await activeStoreWriters.run(writer, fn);
  } finally {
    if (timing) {
      timing.finishedAt = performance.now();
    }
    writer.active = false;
  }
}

function getOrCreateStoreWriterQueue(
  queues: StoreWriterQueues,
  storePath: string,
): StoreWriterQueue {
  const existing = queues.get(storePath);
  if (existing) {
    return existing;
  }
  const created: StoreWriterQueue = { pending: [], drainPromise: null };
  queues.set(storePath, created);
  return created;
}

async function drainStoreWriterQueue(queues: StoreWriterQueues, storePath: string): Promise<void> {
  const queue = queues.get(storePath);
  if (!queue || queue.drainPromise) {
    return;
  }
  const drain = createDeferredCore();
  // Publish ownership before the first writer can enqueue more work, without
  // yielding its place to a competing lifecycle admission on an idle lane.
  queue.drainPromise = drain.promise;
  const heldKeys = new Set<string>();
  let active = 0;
  let changed = createDeferredCore();
  queue.wake = () => changed.resolve();
  let first = true;
  try {
    while (queue.pending.length > 0 || active > 0) {
      const blocked = new Set<string>();
      let task: StoreWriterTask | undefined;
      for (const pending of queue.pending) {
        const keys = pending.keys;
        if (!keys) {
          if (active === 0 && blocked.size === 0) {
            task = pending;
          }
          break;
        }
        if (![...keys].some((key) => heldKeys.has(key) || blocked.has(key))) {
          task = pending;
          break;
        }
        // A later task cannot bypass an earlier overlapping waiter, even if its key is idle.
        for (const key of keys) {
          blocked.add(key);
        }
      }
      if (!task) {
        await changed.promise;
        changed = createDeferredCore();
        continue;
      }
      let wait: Promise<void> | undefined;
      // Every resumed drain claims again; sharing only the wakeup would admit the whole herd.
      while ((wait = claimStoreWriterTurn(first))) {
        await wait;
      }
      first = false;
      const index = queue.pending.indexOf(task);
      if (index < 0) {
        continue;
      }
      queue.pending.splice(index, 1);
      if (!task.keys) {
        await task.fn().then(task.resolve, task.reject);
        continue;
      }
      const keys = task.keys;
      for (const key of keys) {
        heldKeys.add(key);
      }
      active++;
      const finish = () => {
        for (const key of keys) {
          heldKeys.delete(key);
        }
        active--;
        queue.wake?.();
      };
      void task.fn().then(
        (value) => {
          finish();
          task.resolve(value);
        },
        (error: unknown) => {
          finish();
          task.reject(error);
        },
      );
    }
  } finally {
    queue.drainPromise = null;
    queue.wake = undefined;
    // No enqueue can interleave with this synchronous empty-queue cleanup.
    queues.delete(storePath);
    drain.resolve();
  }
}

/** Runs one store write after prior writes for the same store path have finished. */
export async function runQueuedStoreWrite<T>(params: {
  queues: StoreWriterQueues;
  storePath: string;
  label: string;
  fn: () => Promise<T>;
  reentrant?: boolean;
  timing?: StoreWriterTiming;
  /** Complete conflict set; omitted or empty keys reserve the whole store. */
  keys?: readonly string[];
  /** Cancellation removes only a waiting task; admitted work must settle normally. */
  signal?: AbortSignal;
}): Promise<T> {
  if (!params.storePath || typeof params.storePath !== "string") {
    throw new Error(
      `${params.label}: storePath must be a non-empty string, got ${JSON.stringify(
        params.storePath,
      )}`,
    );
  }
  params.signal?.throwIfAborted();
  const keys = params.keys?.length ? new Set(params.keys) : undefined;
  // Explicit reentrancy keeps one logical read/decide/write section on the
  // active lane; ordinary async children must queue behind the current writer.
  if (params.reentrant === true && isActiveStoreWriter(params.queues, params.storePath, keys)) {
    if (params.timing) {
      params.timing.reentrant = true;
      params.timing.startedAt = performance.now();
    }
    try {
      return await params.fn();
    } finally {
      if (params.timing) {
        params.timing.finishedAt = performance.now();
      }
    }
  }
  // A queued writer retains its caller's authority, never the preceding writer's
  // async context. The active-writer scope still belongs to actual execution.
  const runInAsyncContext = AsyncLocalStorage.snapshot();
  const queue = getOrCreateStoreWriterQueue(params.queues, params.storePath);
  let detach = () => {};
  const completion = new Promise<T>((resolve, reject) => {
    detach = () => params.signal?.removeEventListener("abort", abort);
    const abort = () => {
      const index = queue.pending.indexOf(task);
      if (index !== -1) {
        queue.pending.splice(index, 1);
        task.reject(params.signal?.reason);
        queue.wake?.();
      }
    };
    const task: StoreWriterTask = {
      keys,
      fn: async () => {
        detach();
        return await runInAsyncContext(
          runActiveStoreWriter,
          params.queues,
          params.storePath,
          params.fn,
          params.timing,
          keys,
        );
      },
      resolve: (value) => resolve(value as T),
      reject,
    };
    queue.pending.push(task);
    queue.wake?.();
    params.signal?.addEventListener("abort", abort, { once: true });
    void drainStoreWriterQueue(params.queues, params.storePath);
  });
  if (params.signal) {
    // Observe cleanup without adding a settlement hop to the writer's result.
    void completion.then(detach, detach);
  }
  return await completion;
}

/** Rejects pending queued writes and clears idle queue state for test cleanup. */
export function clearStoreWriterQueuesForTest(queues: StoreWriterQueues, message: string): void {
  for (const [storePath, queue] of queues) {
    for (const task of queue.pending) {
      task.reject(new Error(message));
    }
    queue.pending.length = 0;
    queue.wake?.();
    // An active writer keeps its lane; a fresh queue would admit a second writer.
    if (!queue.drainPromise) {
      queues.delete(storePath);
    }
  }
}
