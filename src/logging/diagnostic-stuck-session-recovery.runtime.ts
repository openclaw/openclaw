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
  // Precise semantic cause the recovery acts on (e.g. blocked_tool_call). Commit it
  // on the controller-owned operation BEFORE the watchdog tick so the controller's
  // authoritative stall-stop path records it instead of only its mechanical
  // effect.reason fallback. The controller keeps this value (it writes the fallback
  // only when the field is still undefined), so the precise cause survives even when
  // the watchdog returns "blocked" before the post-tick assignment would run.
  const preciseCause = params.classification?.classification;
  try {
    if (preciseCause !== undefined) {
      operation.recoveryClassification = preciseCause;
    }
    const decision = await operation.watchdog.tick();
    if (decision.action === "observe" && decision.reason === "model_recovery") {
      // No abort happened; do not leave the precise cause lingering on the operation.
      if (preciseCause !== undefined) {
        operation.recoveryClassification = undefined;
      }
      return reportOutcome({
        ...base,
        status: "skipped",
        action: "keep_lane",
        reason: "model_attempt_recovery",
      });
    }
    const state = operation.watchdog.snapshot();
    // Semantic cause the recovery acted on (e.g. blocked_tool_call), falling back
    // to the watchdog decision reason when no attention classification was supplied.
    const recoveryReason = params.classification?.classification ?? decision.reason;
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
            reason: recoveryReason,
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
    // The skipped branch (no abort) must not surface the precise cause; clear it so a
    // later finalization does not mistake an uninterrupted run for a stalled one.
    if (outcome.status === "skipped" && preciseCause !== undefined) {
      operation.recoveryClassification = undefined;
    }
    if (outcome.status === "aborted" && recoveryReason) {
      // Surface the semantic cause on the controller-owned operation so cron run
      // finalization can include it in both the run history and the chat alert,
      // instead of a cause-free literal. No separate diagnostic-owned store needed.
      // The controller's authoritative stall-stop path (expireOwner -> abortForStall)
      // already records a mechanical fallback before the abort commits; this overwrites
      // it with the precise semantic cause supplied by diagnostics when available.
      operation.recoveryClassification = recoveryReason;
    }
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
