import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { createDeferredCore } from "../../shared/deferred.js";

export type SessionCatalogListTiming = {
  admittedAt?: number;
  settledAt?: number;
  continuationWaitMs?: number;
  admittedStepMs?: number;
  stepCount?: number;
};

type QueuedProviderList = {
  start: () => void;
};

type ProviderListStep<T> = { done: false } | { done: true; value: T };

class SessionCatalogListBusyError extends Error {
  readonly code = "catalog_busy";

  constructor(maxConcurrent: number, maxQueued: number) {
    super(`session catalog is busy (${maxConcurrent} active, ${maxQueued} queued); retry shortly`);
    this.name = "SessionCatalogListBusyError";
  }
}

export class SessionCatalogListAdmission {
  private active = 0;
  private readonly queue: QueuedProviderList[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
  ) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error("maxConcurrent must be a positive integer");
    }
    if (!Number.isInteger(maxQueued) || maxQueued < 0) {
      throw new Error("maxQueued must be a non-negative integer");
    }
  }

  async run<T>(
    task: () => Promise<T>,
    signal?: AbortSignal,
    timing?: SessionCatalogListTiming,
  ): Promise<T> {
    return await this.runSteps(async () => ({ done: true, value: await task() }), signal, timing);
  }

  async runSteps<T>(
    step: () => Promise<ProviderListStep<T>>,
    signal?: AbortSignal,
    timing?: SessionCatalogListTiming,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (this.active >= this.maxConcurrent && this.queue.length >= this.maxQueued) {
      throw new SessionCatalogListBusyError(this.maxConcurrent, this.maxQueued);
    }
    // Even an immediate first step may later resume from another caller's drain.
    const runInAsyncContext = AsyncLocalStorage.snapshot();
    const completion = createDeferredCore<T>();
    let continuationQueuedAt: number | undefined;
    const finishQueueWait = (now: number) => {
      if (continuationQueuedAt !== undefined && timing) {
        timing.continuationWaitMs = (timing.continuationWaitMs ?? 0) + now - continuationQueuedAt;
      }
      continuationQueuedAt = undefined;
    };
    const onAbort = () => {
      const index = this.queue.indexOf(entry);
      if (index < 0) {
        return;
      }
      this.queue.splice(index, 1);
      signal?.removeEventListener("abort", onAbort);
      const now = performance.now();
      finishQueueWait(now);
      if (timing?.admittedAt !== undefined) {
        timing.settledAt = now;
      }
      completion.reject(signal?.reason);
    };
    const enqueue = () => {
      this.queue.push(entry);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
      }
    };
    const entry: QueuedProviderList = {
      start: () => {
        signal?.removeEventListener("abort", onAbort);
        void runInAsyncContext(async () => {
          const startedAt = performance.now();
          finishQueueWait(startedAt);
          this.active += 1;
          if (timing) {
            timing.admittedAt ??= startedAt;
            timing.stepCount = (timing.stepCount ?? 0) + 1;
          }
          let continued = false;
          try {
            signal?.throwIfAborted();
            const result = await step();
            if (result.done) {
              completion.resolve(result.value);
            } else {
              signal?.throwIfAborted();
              continued = true;
            }
          } catch (error) {
            completion.reject(error);
          } finally {
            const settledAt = performance.now();
            if (timing) {
              timing.admittedStepMs = (timing.admittedStepMs ?? 0) + settledAt - startedAt;
              if (!continued) {
                timing.settledAt = settledAt;
              }
            }
            this.active -= 1;
            if (continued) {
              if (timing) {
                timing.continuationWaitMs ??= 0;
              }
              // Reserve the accepted continuation before the next caller runs:
              // its synchronous arrivals cannot take this operation's queue place.
              const next = this.queue.shift();
              if (next) {
                continuationQueuedAt = settledAt;
                enqueue();
                next.start();
              } else {
                entry.start();
              }
            }
            this.drain();
          }
        });
      },
    };
    if (this.active < this.maxConcurrent) {
      entry.start();
    } else {
      enqueue();
    }
    return await completion.promise;
  }

  private drain(): void {
    while (this.active < this.maxConcurrent) {
      const next = this.queue.shift();
      if (!next) {
        return;
      }
      next.start();
    }
  }
}
