import { performance } from "node:perf_hooks";
import { createDeferredCore } from "../../shared/deferred.js";

export type SessionCatalogListTiming = {
  admittedAt?: number;
  settledAt?: number;
  continuationWaitMs?: number;
  admittedStepMs?: number;
  stepCount?: number;
};

type QueuedProviderList = { start: () => void };

type ProviderListStep<T> = { done: false } | { done: true; value: T };

class SessionCatalogListBusyError extends Error {
  readonly code = "catalog_busy";

  constructor(active: number, queued: number) {
    super(`session catalog is busy (${active} active, ${queued} queued); retry shortly`);
    this.name = "SessionCatalogListBusyError";
  }
}

export class SessionCatalogListAdmission {
  private active = 0;
  private readonly queue: QueuedProviderList[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
  ) {}

  async run<T>(
    task: () => Promise<T>,
    signal?: AbortSignal,
    timing?: SessionCatalogListTiming,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (this.active >= this.maxConcurrent) {
      if (this.queue.length >= this.maxQueued) {
        throw new SessionCatalogListBusyError(this.active, this.queue.length);
      }
      const ready = createDeferredCore();
      const entry = { start: () => ready.resolve() };
      const onAbort = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) {
          this.queue.splice(index, 1);
          ready.reject(signal?.reason);
        }
      };
      this.queue.push(entry);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await ready.promise;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    } else {
      this.active++;
    }
    const startedAt = performance.now();
    if (timing) {
      timing.admittedAt = startedAt;
    }
    try {
      signal?.throwIfAborted();
      return await task();
    } finally {
      if (timing) {
        timing.settledAt = performance.now();
        timing.stepCount ??= 1;
        timing.admittedStepMs ??= timing.settledAt - startedAt;
      }
      const next = this.queue.shift();
      if (next) {
        next.start();
      } else {
        this.active--;
      }
    }
  }

  async runSteps<T>(
    step: () => Promise<ProviderListStep<T>>,
    signal?: AbortSignal,
    timing?: SessionCatalogListTiming,
  ): Promise<T> {
    // A list holds its slot until complete; sparse scans may delay the same provider.
    return this.run(
      async () => {
        for (;;) {
          signal?.throwIfAborted();
          const startedAt = performance.now();
          const result = await step();
          if (timing) {
            timing.stepCount = (timing.stepCount ?? 0) + 1;
            timing.admittedStepMs = (timing.admittedStepMs ?? 0) + performance.now() - startedAt;
          }
          if (result.done) {
            return result.value;
          }
        }
      },
      signal,
      timing,
    );
  }
}
