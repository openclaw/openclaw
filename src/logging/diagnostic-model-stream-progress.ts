import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  areDiagnosticsEnabledForProcess,
  emitTrustedDiagnosticEvent,
} from "../infra/diagnostic-events.js";
import {
  emitDiagnosticsTimelineEvent,
  isDiagnosticsTimelineEnabled,
} from "../infra/diagnostics-timeline.js";
import { markDiagnosticRunProgress } from "./diagnostic-run-activity.js";

const MODEL_CALL_STREAM_PROGRESS_INTERVAL_MS = 30_000;

/** Canonical progress reason for model output observed on a live backend stream. */
const MODEL_CALL_STREAM_PROGRESS_REASON = "model_call:stream_progress";

export type ModelCallStreamProgressTarget = {
  runId: string;
  callId?: string;
  sessionKey?: string;
  sessionId?: string;
};

// Refresh recovery on every chunk, but throttle public events. Owner-bound
// callbacks also reject late output without refreshing a replacement's clock.
export function createModelCallStreamProgressReporter({
  recordProgress,
  config,
}: { recordProgress?: () => boolean; config?: OpenClawConfig } = {}): (
  target: ModelCallStreamProgressTarget,
) => void {
  let lastEmittedAtMs: number | undefined;
  return (target) => {
    if (recordProgress && !recordProgress()) {
      return;
    }
    const diagnosticsEnabled = areDiagnosticsEnabledForProcess();
    const fields = {
      runId: target.runId,
      ...(target.sessionKey ? { sessionKey: target.sessionKey } : {}),
      ...(target.sessionId ? { sessionId: target.sessionId } : {}),
      reason: MODEL_CALL_STREAM_PROGRESS_REASON,
    };
    if (diagnosticsEnabled && !recordProgress) {
      markDiagnosticRunProgress(fields);
    }
    const now = Date.now();
    if (
      lastEmittedAtMs !== undefined &&
      now - lastEmittedAtMs < MODEL_CALL_STREAM_PROGRESS_INTERVAL_MS
    ) {
      return;
    }
    // Timeline flags only matter when a public heartbeat can be emitted.
    const timelineEnabled = target.callId !== undefined && isDiagnosticsTimelineEnabled({ config });
    if (!diagnosticsEnabled && !timelineEnabled) {
      return;
    }
    lastEmittedAtMs = now;
    if (diagnosticsEnabled) {
      emitTrustedDiagnosticEvent({ type: "run.progress", ...fields });
    }
    if (timelineEnabled) {
      emitDiagnosticsTimelineEvent(
        {
          type: "mark",
          name: "provider.request.activity",
          timestamp: new Date(now).toISOString(),
          runId: target.runId,
          spanId: target.callId,
        },
        { config },
      );
    }
  };
}
