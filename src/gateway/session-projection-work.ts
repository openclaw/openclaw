import { setImmediate as yieldToEventLoop } from "node:timers/promises";

let pendingYield: Promise<void> | undefined;

/** Resident projection drains share one pending event-loop yield. */
export function yieldSessionListWork(): Promise<void> {
  return (pendingYield ??= yieldToEventLoop().finally(() => {
    pendingYield = undefined;
  }));
}
