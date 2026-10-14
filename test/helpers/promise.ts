import type { StoreWriterQueue } from "../../src/shared/store-writer-queue.js";

export { createDeferredCore as createDeferred } from "../../src/shared/deferred.js";

/** Waits for active drains to settle while rejecting still-pending test writes. */
export async function drainStoreWriterQueuesForTest(
  queues: Map<string, StoreWriterQueue>,
  message: string,
): Promise<void> {
  while (queues.size > 0) {
    const activeQueues = [...queues.values()];
    for (const queue of activeQueues) {
      for (const task of queue.pending) {
        task.reject(new Error(message));
      }
      queue.pending.length = 0;
    }
    const activeDrains = activeQueues.flatMap((queue) =>
      queue.drainPromise ? [queue.drainPromise] : [],
    );
    if (activeDrains.length === 0) {
      queues.clear();
      return;
    }
    await Promise.allSettled(activeDrains);
  }
}

/**
 * Resolves with `gate` unless the operation expected to reach it settles first, which
 * fails with `message` (an early rejection keeps its own error). There is deliberately no
 * timer: a gate that is never reached fails at the Vitest test timeout, so healthy work
 * slowed by a loaded runner cannot lose a race against a wall-clock deadline.
 */
export function awaitGateBeforeSettlement<T>(
  gate: PromiseLike<T>,
  operation: PromiseLike<unknown>,
  message: string,
): Promise<Awaited<T>> {
  return Promise.race([
    gate,
    Promise.resolve(operation).then((): never => {
      throw new Error(message);
    }),
  ]);
}

/**
 * Settles with `work`, or rejects with the abort reason once Vitest aborts the test context
 * `signal` (timeout or cancellation). Vitest does not unwind a suspended test body when it
 * times out, so awaits guarded by `finally` cleanup use this to let that cleanup still run.
 */
export function withinTest<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<Awaited<T>> {
  let onAbort = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error("test aborted", { cause: reason }));
    };
  });
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return Promise.race([work, aborted]).finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
}

export async function withTestTimeout<T>(
  promise: PromiseLike<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export async function raceWithTimeoutResult<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutResult: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(timeoutResult), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
