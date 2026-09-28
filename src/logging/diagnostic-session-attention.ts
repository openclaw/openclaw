import type { DiagnosticSessionActiveWorkKind } from "../infra/diagnostic-events.js";
import type { DiagnosticSessionActivitySnapshot } from "./diagnostic-run-activity.js";

export type SessionAttentionClassification =
  | {
      eventType: "session.long_running";
      reason: string;
      classification: "long_running";
      activeWorkKind?: DiagnosticSessionActiveWorkKind;
      recoveryEligible: false;
    }
  | {
      eventType: "session.stalled";
      reason: string;
      classification: "blocked_tool_call" | "stalled_agent_run";
      activeWorkKind?: DiagnosticSessionActiveWorkKind;
      recoveryEligible: false;
    }
  | {
      eventType: "session.stuck";
      reason: string;
      classification: "stale_session_state";
      activeWorkKind?: undefined;
      recoveryEligible: true;
    };

export function isRepeatedModelRequestStalled(
  activity: DiagnosticSessionActivitySnapshot,
  abortThresholdMs: number,
): boolean {
  const now = Date.now();
  return (
    activity.hasActiveEmbeddedRun === true &&
    (activity.repeatedRequestNoProgressAgeMs ?? 0) >=
      Math.max(abortThresholdMs, activity.activeModelCallRequestTimeoutMs ?? 0) &&
    (activity.activeRetryWaitDeadlineAtMs === undefined ||
      now >= activity.activeRetryWaitDeadlineAtMs) &&
    (activity.activeToolRecoveryDeadlineAtMs === undefined ||
      now >= activity.activeToolRecoveryDeadlineAtMs)
  );
}

export function classifySessionAttention(params: {
  state?: "idle" | "processing" | "waiting";
  queueDepth: number;
  activity: DiagnosticSessionActivitySnapshot;
  staleMs: number;
  stuckSessionAbortMs?: number;
  runtimeOwnsLiveness?: boolean;
}): SessionAttentionClassification {
  const longRunning = (reason: string): SessionAttentionClassification => ({
    eventType: "session.long_running",
    reason,
    classification: "long_running",
    activeWorkKind: params.activity.activeWorkKind,
    recoveryEligible: false,
  });
  const stalled = (
    reason: string,
    classification: "blocked_tool_call" | "stalled_agent_run" = "stalled_agent_run",
  ): SessionAttentionClassification => ({
    eventType: "session.stalled",
    reason,
    classification,
    activeWorkKind: params.activity.activeWorkKind,
    recoveryEligible: false,
  });
  if (
    params.activity.activeRetryWaitDeadlineAtMs !== undefined &&
    Date.now() < params.activity.activeRetryWaitDeadlineAtMs
  ) {
    return longRunning("provider_retry_wait");
  }
  if (params.runtimeOwnsLiveness) {
    return longRunning("runtime_owned_wait");
  }
  if (params.activity.activeWorkKind) {
    const lastProgressAgeMs = params.activity.lastProgressAgeMs ?? 0;
    if (
      params.activity.hasActiveEmbeddedRun === true &&
      typeof params.stuckSessionAbortMs === "number" &&
      (params.activity.repeatedRequestNoProgressAgeMs ?? 0) >= params.stuckSessionAbortMs
    ) {
      return stalled("repeated_model_requests_without_progress");
    }

    // Idle session with queued work and stale orphaned activity (no active
    // embedded owner) should be classified as recoverable stuck state, not as
    // stalled active work. This prevents orphaned model_call or tool_call
    // activity from blocking the queue indefinitely.
    if (
      params.state === "idle" &&
      params.queueDepth > 0 &&
      params.activity.hasActiveEmbeddedRun !== true &&
      lastProgressAgeMs > params.staleMs
    ) {
      return {
        eventType: "session.stuck",
        reason: "queued_work_without_active_run",
        classification: "stale_session_state",
        recoveryEligible: true,
      };
    }
    if (
      params.activity.activeWorkKind === "tool_call" &&
      (params.activity.activeToolAgeMs ?? 0) > params.staleMs &&
      lastProgressAgeMs > params.staleMs
    ) {
      return stalled("blocked_tool_call", "blocked_tool_call");
    }
    if (
      params.queueDepth > 0 &&
      params.activity.activeWorkKind === "embedded_run" &&
      isTerminalDiagnosticProgressReason(params.activity.lastProgressReason)
    ) {
      return stalled("queued_behind_terminal_active_work");
    }
    if (
      params.activity.activeWorkKind === "model_call" &&
      params.activity.hasActiveEmbeddedRun === true &&
      lastProgressAgeMs > params.staleMs
    ) {
      if (
        typeof params.stuckSessionAbortMs === "number" &&
        lastProgressAgeMs >= params.stuckSessionAbortMs
      ) {
        return stalled("active_work_without_progress");
      }
      return longRunning("active_model_call_without_progress");
    }
    if (lastProgressAgeMs > params.staleMs) {
      return stalled("active_work_without_progress");
    }
    return longRunning(params.queueDepth > 0 ? "queued_behind_active_work" : "active_work");
  }

  return {
    eventType: "session.stuck",
    reason: params.queueDepth > 0 ? "queued_work_without_active_run" : "stale_session_state",
    classification: "stale_session_state",
    recoveryEligible: true,
  };
}

export function isTerminalDiagnosticProgressReason(reason: string | undefined): boolean {
  if (!reason) {
    return false;
  }
  return (
    reason === "run:completed" ||
    reason === "embedded_run:ended" ||
    reason.includes("response.completed") ||
    reason.includes("rawResponseItem/completed") ||
    reason.includes("raw_response_item.completed") ||
    reason.includes("output_item.done")
  );
}
