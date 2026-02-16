import { createReactionDebouncer, DEFAULT_BUNDLE_WINDOW_MS } from "./debouncer.js";
import { dispatchReactionEvent } from "./dispatch.js";

let instance: ReturnType<typeof createReactionDebouncer> | null = null;
let initialBundleWindowMs: number | undefined;

export function getReactionDebouncer(bundleWindowMs?: number) {
  if (!instance) {
    initialBundleWindowMs = bundleWindowMs ?? DEFAULT_BUNDLE_WINDOW_MS;
    instance = createReactionDebouncer({
      bundleWindowMs,
      onFlush: dispatchReactionEvent,
    });
  } else if (
    bundleWindowMs !== undefined &&
    initialBundleWindowMs !== undefined &&
    bundleWindowMs !== initialBundleWindowMs
  ) {
    console.warn(
      `[reaction-debouncer] bundleWindowMs mismatch: requested ${bundleWindowMs}ms but singleton uses ${initialBundleWindowMs}ms`,
    );
  }
  return instance;
}

export function getReactionDebouncerIfExists() {
  return instance;
}
