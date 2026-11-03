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

export function startSessionCreateDiagnostics() {
  const logEnabled = areDiagnosticsEnabledForProcess() && sessionLog.isEnabled("warn");
  if (!logEnabled) {
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
      if (snapshot.totalMs < 1_000 || !areDiagnosticsEnabledForProcess()) {
        return;
      }
      const phaseDurationsMs: Record<string, number> = {};
      for (const stage of snapshot.stages) {
        phaseDurationsMs[stage.name] = (phaseDurationsMs[stage.name] ?? 0) + stage.durationMs;
      }
      const fields = { elapsedMs: snapshot.totalMs, phaseDurationsMs };
      try {
        sessionLog.warn("slow session create", fields);
      } catch {
        // Diagnostic sinks cannot replace creation's response or original error.
      }
    },
  };
}
