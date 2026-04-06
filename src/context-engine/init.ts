import { registerLegacyContextEngine } from "./legacy.js";
import { registerPointerContextEngine } from "./pointer.js";

/**
 * Ensures all built-in context engines are registered exactly once.
 *
 * The legacy engine is always registered as a safe fallback so that
 * `resolveContextEngine()` can resolve the default "legacy" slot without
 * callers needing to remember manual registration.
 *
 * The pointer engine is always registered so it is available when
 * compaction.mode is "pointer" or plugins.slots.contextEngine is "pointer".
 *
 * Additional engines are registered by their own plugins via
 * `api.registerContextEngine()` during plugin load.
 */
let initialized = false;

export function ensureContextEnginesInitialized(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  // Always available – safe fallback for the "legacy" slot default.
  registerLegacyContextEngine();

  // Opt-in lossless compaction mode: selected via compaction.mode="pointer"
  // or plugins.slots.contextEngine="pointer".
  registerPointerContextEngine();
}
