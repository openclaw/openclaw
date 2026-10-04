import { performance } from "node:perf_hooks";
import { areDiagnosticsEnabledForProcess } from "../infra/diagnostic-events.js";
import {
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { createStageTimingTracker } from "../shared/stage-timing.js";

export const SLOW_GATEWAY_REQUEST_MS = 1_000;

export type SessionSubscribePhase =
  | "setup"
  | "projectionReadiness"
  | "accessFacts"
  | "handlerPreparation"
  | "retainedReadAdmission"
  | "replayPreparation"
  | "observerCommit"
  | "response"
  | "cleanup";

/** The router owns the lifetime so preparation waits are included before handler entry. */
export function startSlowRequestDiagnostics<Phase extends string>(
  log: Pick<SubsystemLogger, "warn" | "isEnabled">,
  message: string,
  operation: string,
  initialPhase: Phase,
) {
  if (!areDiagnosticsEnabledForProcess() || !log.isEnabled("warn")) {
    return undefined;
  }
  let checkpoint = performance.now();
  const startedAt = checkpoint;
  const timing = createStageTimingTracker(() => checkpoint);
  const trace = getActiveDiagnosticTraceContext();
  let phase = initialPhase;
  const mark = (next: Phase) => {
    checkpoint = performance.now();
    timing.mark(phase);
    phase = next;
  };
  return {
    mark,
    [Symbol.dispose]() {
      mark(phase);
      const elapsedMs = checkpoint - startedAt;
      if (elapsedMs < SLOW_GATEWAY_REQUEST_MS || !areDiagnosticsEnabledForProcess()) {
        return;
      }
      try {
        const phaseDurationsMs: Record<string, number> = {};
        for (const stage of timing.snapshot().stages) {
          phaseDurationsMs[stage.name] = (phaseDurationsMs[stage.name] ?? 0) + stage.durationMs;
        }
        runWithDiagnosticTraceContext(trace, () =>
          log.warn(message, { operation, elapsedMs: Math.round(elapsedMs), phaseDurationsMs }),
        );
      } catch {
        // Diagnostic sinks cannot replace the response or original error.
      }
    },
  };
}
