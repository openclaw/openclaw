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
