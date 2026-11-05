import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
import { areDiagnosticsEnabledForProcess } from "../infra/diagnostic-events.js";
import {
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { createStageTimingTracker } from "../shared/stage-timing.js";

export const SLOW_GATEWAY_REQUEST_MS = 1_000;
const stages = channel("openclaw.gateway.request.stages");

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
  details?: () => Record<string, unknown>,
  observedSpans: readonly string[] = [],
) {
  if (!stages.hasSubscribers && (!areDiagnosticsEnabledForProcess() || !log.isEnabled("warn"))) {
    return undefined;
  }
  let checkpoint = performance.now();
  const startedAt = checkpoint;
  const timing = createStageTimingTracker(() => checkpoint);
  const trace = getActiveDiagnosticTraceContext();
  const spans = new Map<string, number>();
  let finished = false;
  let phase = initialPhase;
  const mark = (next: Phase) => {
    checkpoint = performance.now();
    timing.mark(phase);
    phase = next;
  };
  return {
    mark,
    observeSpan: (name: string) => {
      if (finished || !observedSpans.includes(name)) {
        return undefined;
      }
      const started = performance.now();
      return () => {
        if (!finished) {
          spans.set(name, (spans.get(name) ?? 0) + performance.now() - started);
        }
      };
    },
    [Symbol.dispose]() {
      mark(phase);
      finished = true;
      const elapsedMs = checkpoint - startedAt;
      const warn =
        elapsedMs >= SLOW_GATEWAY_REQUEST_MS &&
        areDiagnosticsEnabledForProcess() &&
        log.isEnabled("warn");
      if (!warn && !stages.hasSubscribers) {
        return;
      }
      try {
        const phaseDurationsMs: Record<string, number> = {};
        for (const stage of timing.snapshot().stages) {
          phaseDurationsMs[stage.name] = (phaseDurationsMs[stage.name] ?? 0) + stage.durationMs;
        }
        // Nested owner spans overlap the outer phases; names are a fixed caller allowlist.
        for (const [name, duration] of spans) {
          phaseDurationsMs[`detail.${name}`] = Math.round(duration);
        }
        // Numeric stages remain observable below the slow-log threshold, without request data.
        stages.publish({ operation, elapsedMs, phaseDurationsMs });
        if (!warn) {
          return;
        }
        runWithDiagnosticTraceContext(trace, () =>
          log.warn(message, {
            operation,
            elapsedMs: Math.round(elapsedMs),
            phaseDurationsMs,
            ...details?.(),
          }),
        );
      } catch {
        // Diagnostic sinks cannot replace the response or original error.
      }
    },
  };
}
