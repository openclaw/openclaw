import { getActiveNativeAttempt } from "../agents/embedded-agent-runner/run-state.js";
import { reconcileSessionControllerDiagnosticState } from "../sessions/session-controller.state.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { diagnosticLogger as diag } from "./diagnostic-runtime.js";
import {
  formatRecoveryOutcome,
  type StuckSessionRecoveryOutcome,
  type StuckSessionRecoveryRequest,
} from "./diagnostic-session-recovery.js";
import { isIncognitoDiagnosticSession } from "./diagnostic-session-state.js";

/** Diagnostics may request a tick, but never decide admission, cancel by ID or clear custody. */
export async function recoverStuckDiagnosticSession(
  params: StuckSessionRecoveryRequest,
): Promise<StuckSessionRecoveryOutcome> {
  // Keep privacy after the diagnostic alias retires while recovery loads or runs.
  const incognito =
    isIncognitoDiagnosticSession(params) || isIncognitoSessionKey(params.operation?.key);
  const reportOutcome = (outcome: StuckSessionRecoveryOutcome) => {
    if (!incognito) {
      diag.warn("stuck session recovery outcome: " + formatRecoveryOutcome(outcome));
    }
    return outcome;
  };
  const operation = params.operation;
  const base = { sessionId: params.sessionId, sessionKey: params.sessionKey };
  if (!operation) {
    const state =
      params.sessionId && getActiveNativeAttempt(params.sessionId)
        ? undefined
        : reconcileSessionControllerDiagnosticState(params);
    if (state) {
      return reportOutcome({
        ...base,
        status: "noop",
        action: "reconcile_state",
        reason: state === "waiting" ? "pending_session_work" : "no_active_work",
      });
    }
    return { ...base, status: "skipped", action: "observe_only", reason: "missing_session_ref" };
  }
  try {
    const decision = await operation.watchdog.tick();
    if (decision.action === "observe" && decision.reason === "model_recovery") {
      return reportOutcome({
        ...base,
        status: "skipped",
        action: "keep_lane",
        reason: "model_attempt_recovery",
      });
    }
    const state = operation.watchdog.snapshot();
    const outcome: StuckSessionRecoveryOutcome =
      state.recovery?.status === "settled" && decision.action === "stop"
        ? {
            ...base,
            status: "aborted",
            action: "abort_embedded_run",
            aborted: true,
            drained: true,
            forceCleared: false,
            released: 0,
          }
        : decision.action === "blocked" || state.recovery?.status === "blocked"
          ? {
              ...base,
              status: "failed",
              action: "none",
              reason: "exception",
              error:
                state.recovery?.error ??
                "Watchdog cleanup blocked: exact owner retains write-capable work",
            }
          : {
              ...base,
              status: "skipped",
              action: "observe_only",
              reason:
                state.recovery?.status === "settled" && decision.action === "expire_cleanup"
                  ? "terminal_outcome_committed"
                  : !state.current
                    ? "stale_session_state"
                    : "active_reply_work",
            };
    return reportOutcome(outcome);
  } catch (error) {
    return reportOutcome({
      ...base,
      status: "failed",
      action: "none",
      reason: "exception",
      error: String(error),
    });
  }
}
