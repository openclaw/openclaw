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
  providerId: string;
  start: () => void;
};

type ProviderListStep<T> = { done: false } | { done: true; value: T };

class SessionCatalogListBusyError extends Error {
  readonly code = "catalog_busy";

  constructor(active: number, queued: number) {
    super(`session catalog is busy (${active} active, ${queued} queued); retry shortly`);
    this.name = "SessionCatalogListBusyError";
  }
}

export class SessionCatalogListAdmission {
  private readonly activeProviders = new Set<string>();
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
    providerId: string,
    task: () => Promise<T>,
    signal?: AbortSignal,
    timing?: SessionCatalogListTiming,
  ): Promise<T> {
    return await this.runSteps(
      providerId,
      async () => ({ done: true, value: await task() }),
      signal,
      timing,
    );
  }

  async runSteps<T>(
    providerId: string,
    step: () => Promise<ProviderListStep<T>>,
    signal?: AbortSignal,
    timing?: SessionCatalogListTiming,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (!this.canStart(providerId) && this.queue.length >= this.maxQueued) {
      throw new SessionCatalogListBusyError(this.activeProviders.size, this.queue.length);
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
      providerId,
      start: () => {
        signal?.removeEventListener("abort", onAbort);
        void runInAsyncContext(async () => {
          const startedAt = performance.now();
          finishQueueWait(startedAt);
          this.activeProviders.add(providerId);
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
            this.activeProviders.delete(providerId);
            if (continued) {
              if (timing) {
                timing.continuationWaitMs ??= 0;
              }
              // Reserve the accepted continuation before the next caller runs:
              // its synchronous arrivals cannot take this operation's queue place.
              continuationQueuedAt = settledAt;
              enqueue();
            }
            this.drain();
          }
        });
      },
    };
    enqueue();
    this.drain();
    return await completion.promise;
  }

  private canStart(providerId: string): boolean {
    return this.activeProviders.size < this.maxConcurrent && !this.activeProviders.has(providerId);
  }

  private drain(): void {
    while (this.activeProviders.size < this.maxConcurrent) {
      // A slow provider keeps its FIFO place without blocking other providers' slots.
      const index = this.queue.findIndex((entry) => this.canStart(entry.providerId));
      const next = this.queue[index];
      if (!next) {
        return;
      }
      this.queue.splice(index, 1);
      next.start();
    }
  }
}
