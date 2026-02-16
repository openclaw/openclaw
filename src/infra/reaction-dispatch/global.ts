import { createReactionDebouncer } from "./debouncer.js";
import { dispatchReactionEvent } from "./dispatch.js";

let instance: ReturnType<typeof createReactionDebouncer> | null = null;

export function getReactionDebouncer(bundleWindowMs?: number) {
  if (!instance) {
    instance = createReactionDebouncer({
      bundleWindowMs,
      onFlush: dispatchReactionEvent,
    });
  }
  return instance;
}

export function getReactionDebouncerIfExists() {
  return instance;
}
