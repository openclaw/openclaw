import { performance } from "node:perf_hooks";
import { createQueuedDiagnosticPhaseEmitter } from "./diagnostic-events.js";

const DIFF_READ_STAGES = [
  "admission",
  "checkout-resolve",
  "cache-validate",
  "worker-queue",
  "git-wall",
  "encode",
] as const;
type DiffReadStage = (typeof DIFF_READ_STAGES)[number];

export type DiffReadTiming = {
  durations: Partial<Record<DiffReadStage, number>>;
  outcome?: "cache-hit" | "cache-miss";
};

export function addDiffReadDurations(target: DiffReadTiming, source: DiffReadTiming) {
  for (const stage of DIFF_READ_STAGES) {
    const duration = source.durations[stage];
    if (duration !== undefined) {
      target.durations[stage] = (target.durations[stage] ?? 0) + duration;
    }
  }
}

export function startDiffReadTiming(
  operation: "sessions.diff" | "checkout.diff",
  started = performance.now(),
) {
  const emit = createQueuedDiagnosticPhaseEmitter();
  if (!emit) {
    return undefined;
  }
  const timing: DiffReadTiming = { durations: { "worker-queue": 0, "git-wall": 0 } };
  return {
    ...timing,
    [Symbol.dispose]() {
      // Only completed local cache reads have a cache outcome. Remote and failed reads
      // retain the normal RPC diagnostics instead of masquerading as cache misses.
      if (!this.outcome) {
        return;
      }
      try {
        const ended = performance.now();
        emit({
          name: operation,
          startedAt: performance.timeOrigin + started,
          durationMs: ended - started,
          details: { ...this.durations, outcome: this.outcome },
        });
      } catch {
        // Telemetry cannot replace the response or original error.
      }
    },
  };
}
