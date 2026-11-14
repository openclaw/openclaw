import type { DiagnosticSessionActiveWorkKind } from "../infra/diagnostic-events.js";

export type DiagnosticSessionActivitySnapshot = {
  activeWorkKind?: DiagnosticSessionActiveWorkKind;
  hasActiveEmbeddedRun?: boolean;
  activeToolName?: string;
  activeToolCallId?: string;
  activeToolAgeMs?: number;
  activeToolDeadlineAtMs?: number;
  lastProgressAgeMs?: number;
  lastProgressReason?: string;
  repeatedRequestNoProgressAgeMs?: number;
  /** Quiet allowance owned by the current core request generation. */
  activeModelCallRequestTimeoutMs?: number;
  /** Absolute quiet deadline validated against the exact executing backend owner. */
  activeBackendLivenessDeadlineAtMs?: number;
  /** Absolute provider retry deadline validated against the live logical run. */
  activeRetryWaitDeadlineAtMs?: number;
};

// Quiet-but-alive tools are normal agent behavior; the CLI byte watchdog kills
// truly silent children within its own deadline. This floor bounds every
// staleness consumer (diagnostic recovery aborts, reply-run stale takeover,
// steer gates): lowering it reopens #88870, removing it reopens #96168.
export const BLOCKED_TOOL_CALL_ABORT_FLOOR_MS = 15 * 60_000;

/** Process expiry starts cancellation; give its result the ordinary stalled-tool window. */
export function resolveToolExecutionRecoveryDeadlineAtMs(
  executionDeadlineAtMs: number | undefined,
): number | undefined {
  return executionDeadlineAtMs === undefined
    ? undefined
    : executionDeadlineAtMs + BLOCKED_TOOL_CALL_ABORT_FLOOR_MS;
}

// Default quiet-run reclaim window for steer/takeover. Evidence clocks stay local.
export const RUN_STALE_TAKEOVER_MS = 10 * 60_000;

// Quiet-but-alive tool phases get the blocked-tool floor so a human message
// cannot reclaim a healthy long tool that stuck recovery would not touch yet.
export function resolveRunStaleThresholdMs(
  activity: Pick<
    DiagnosticSessionActivitySnapshot,
    | "activeWorkKind"
    | "activeToolDeadlineAtMs"
    | "lastProgressAgeMs"
    | "activeModelCallRequestTimeoutMs"
    | "activeBackendLivenessDeadlineAtMs"
    | "activeRetryWaitDeadlineAtMs"
  >,
  evidenceAgeMs = activity.lastProgressAgeMs ?? 0,
  minimumMs = RUN_STALE_TAKEOVER_MS,
): number {
  const retryWaitThresholdMs =
    activity.activeRetryWaitDeadlineAtMs === undefined
      ? 0
      : evidenceAgeMs + activity.activeRetryWaitDeadlineAtMs - Date.now();
  if (activity.activeToolDeadlineAtMs !== undefined) {
    // Use the same age the caller compares: subtracting it leaves only the
    // absolute deadline, even when reply activity and tool progress differ.
    return Math.max(
      0,
      evidenceAgeMs + activity.activeToolDeadlineAtMs - Date.now(),
      retryWaitThresholdMs,
    );
  }
  if (activity.activeWorkKind === "tool_call") {
    return Math.max(minimumMs, BLOCKED_TOOL_CALL_ABORT_FLOOR_MS, retryWaitThresholdMs);
  }
  // The backend starts its quiet allowance at execution, not session admission.
  // Translate its absolute deadline into the same evidence age the caller compares.
  const backendThresholdMs =
    activity.activeBackendLivenessDeadlineAtMs === undefined
      ? 0
      : evidenceAgeMs + activity.activeBackendLivenessDeadlineAtMs - Date.now();
  return Math.max(
    minimumMs,
    activity.activeModelCallRequestTimeoutMs ?? 0,
    backendThresholdMs,
    retryWaitThresholdMs,
  );
}
