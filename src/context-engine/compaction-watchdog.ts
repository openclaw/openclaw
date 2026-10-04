// The host compaction watchdog is keyed by the abort signal it hands to the engine.
// Engines that delegate pass that signal through, so the canonical runtime delegate
// can refresh the watchdog however many plugin wrappers sit in between. The registry
// lives on globalThis so duplicated dist chunks share it.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export const compactionWatchdogResets = resolveGlobalSingleton<WeakMap<AbortSignal, () => void>>(
  Symbol.for("openclaw.compactionWatchdogResets"),
  () => new WeakMap(),
);
