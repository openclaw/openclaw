import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";

let pendingYield: Promise<void> | undefined;
let foregroundCount = 0;
let foregroundIdle: Deferred | undefined;

/** Resident projection drains share one pending event-loop yield. */
export function yieldSessionListWork(): Promise<void> {
  return (pendingYield ??= yieldToEventLoop().finally(() => {
    pendingYield = undefined;
  }));
}

/** One pending drain also joins work published as its previous batch settles. */
export function createSessionProjectionDrain(params: {
  beforeEnsure(): void;
  hasWork(): boolean;
  refresh(): Promise<void>;
  needsYield(): boolean;
  idle(): Promise<void>;
  runAsOwner<T>(operation: () => T): T;
}): () => Promise<void> {
  let pending: Promise<void> | undefined;
  async function drain() {
    while (params.hasWork()) {
      await params.refresh();
      if (params.needsYield()) {
        await yieldSessionListWork();
      }
    }
  }
  function ensure(): Promise<void> {
    params.beforeEnsure();
    if (!params.hasWork()) {
      return pending ?? params.idle();
    }
    return (pending ??= yieldSessionListWork()
      .then(() => params.runAsOwner(drain))
      .then(
        () => {
          pending = undefined;
          if (params.hasWork()) {
            return ensure();
          }
          return undefined;
        },
        (error: unknown) => {
          pending = undefined;
          throw error;
        },
      ));
  }
  return ensure;
}

/** Optional transcript work must not invalidate a request's asynchronous read or mutation. */
export function retainSessionListForegroundWork(): () => void {
  foregroundCount++;
  let retained = true;
  return () => {
    if (!retained) {
      return;
    }
    retained = false;
    if (--foregroundCount === 0) {
      const idle = foregroundIdle;
      foregroundIdle = undefined;
      idle?.resolve();
    }
  };
}

export function canRunSessionListBackgroundWork(): boolean {
  return foregroundCount === 0;
}

export async function yieldSessionListBackgroundWork(): Promise<void> {
  for (;;) {
    await yieldSessionListWork();
    if (canRunSessionListBackgroundWork()) {
      return;
    }
    foregroundIdle ??= createDeferredCore();
    await foregroundIdle.promise;
  }
}
