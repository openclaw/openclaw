import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
import type { SessionEntryCreationPhase } from "../config/sessions/session-accessor.types.js";
import { areDiagnosticsEnabledForProcess } from "../infra/diagnostic-events.js";
import { createStageTimingTracker } from "../shared/stage-timing.js";
import { sessionLog } from "./server-methods/sessions-shared.js";

export type SessionCreatePhase =
  | SessionEntryCreationPhase
  | "preflight"
  | "admission"
  | "lifecycleAdmission"
  | "targetPreparation"
  | "worktree"
  | "effects"
  | "initialTurn"
  | "response"
  | "handlerExit";

const diagnosticsChannel = channel("openclaw.session.create");

export function startSessionCreateDiagnostics() {
  const logEnabled = areDiagnosticsEnabledForProcess() && sessionLog.isEnabled("warn");
  if (!logEnabled && !diagnosticsChannel.hasSubscribers) {
    return undefined;
  }
  const timing = createStageTimingTracker(() => performance.now());
  let phase: SessionCreatePhase = "preflight";
  const mark = (next: SessionCreatePhase) => {
    timing.mark(phase);
    phase = next;
  };
  return {
    mark,
    [Symbol.dispose]() {
      mark("handlerExit");
      const snapshot = timing.snapshot();
      const shouldLog =
        logEnabled && snapshot.totalMs >= 1_000 && areDiagnosticsEnabledForProcess();
      if (!shouldLog && !diagnosticsChannel.hasSubscribers) {
        return;
      }
      const phaseDurationsMs: Record<string, number> = {};
      for (const stage of snapshot.stages) {
        phaseDurationsMs[stage.name] = (phaseDurationsMs[stage.name] ?? 0) + stage.durationMs;
      }
      const fields = { elapsedMs: snapshot.totalMs, phaseDurationsMs };
      try {
        diagnosticsChannel.publish(fields);
        if (shouldLog) {
          sessionLog.warn("slow session create", fields);
        }
      } catch {
        // Diagnostic sinks cannot replace creation's response or original error.
      }
    },
  };
}
