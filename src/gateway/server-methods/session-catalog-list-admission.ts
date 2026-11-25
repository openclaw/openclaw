import { performance } from "node:perf_hooks";
import { createPermitPool } from "../../shared/permit-pool.js";

export type SessionCatalogListTiming = {
  admittedAt?: number;
  settledAt?: number;
  admittedStepMs?: number;
  stepCount?: number;
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
  private readonly permits: ReturnType<typeof createPermitPool>;

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
  ) {
    this.permits = createPermitPool(maxConcurrent);
  }

  async run<T>(
    task: () => Promise<T>,
    signal?: AbortSignal,
    timing?: SessionCatalogListTiming,
  ): Promise<T> {
    signal?.throwIfAborted();
    let release = this.permits.tryAcquire();
    if (!release) {
      const queued = this.permits.pendingCount;
      if (queued >= this.maxQueued) {
        throw new SessionCatalogListBusyError(this.maxConcurrent, queued);
      }
      release = await this.permits.acquire({ signal });
      if (!release) {
        // No deadline is supplied, so null means caller cancellation.
        throw signal?.reason;
      }
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
      release();
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
