// The host compaction watchdog is keyed by the abort signal it hands to the engine.
// Engines that delegate pass that signal through, so the canonical runtime delegate
// can refresh the watchdog however many plugin wrappers sit in between, and can end
// its own summary request before the host ceiling. The registry lives on globalThis
// so duplicated dist chunks share it.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type CompactionWatchdog = {
  reset: () => void;
  /** Epoch ms of the operation ceiling; resets never extend the window past it. */
  deadlineAt: number;
};

export const compactionWatchdogs = resolveGlobalSingleton<WeakMap<AbortSignal, CompactionWatchdog>>(
  Symbol.for("openclaw.compactionWatchdogs"),
  () => new WeakMap(),
);
