export const SESSION_WATCHDOG_WARNING_MS = 120_000;
export const SESSION_WATCHDOG_ABORT_FLOOR_MS = 5 * 60_000;
export const SESSION_WATCHDOG_QUIET_TOOL_MS = 15 * 60_000;
export const SESSION_WATCHDOG_CLEANUP_MS = 60_000;

export type SessionWatchdogWaitKind =
  | "global_capacity"
  | "deferred_maintenance"
  | "human_question"
  | "approval"
  | "runtime_owned"
  | "retry"
  | "backend";
export type SessionWatchdogPhase = "active" | "finishing" | "terminal" | "settled";
export type SessionWatchdogSnapshot = Readonly<{
  current: boolean;
  phase: SessionWatchdogPhase;
  hasActiveAttempt?: boolean;
  semanticProgressAtMs: number;
  transportProgressAtMs: number;
  lastProgressReason?: string;
  warningMs: number;
  semanticDeadlineAtMs: number;
  executionDeadlineAtMs?: number;
  cleanupDeadlineAtMs?: number;
  waits: ReadonlyArray<{ kind: SessionWatchdogWaitKind; deadlineAtMs?: number }>;
  requests?: ReadonlyArray<{ requestTimeoutMs?: number; deadlineAtMs?: number }>;
  tools: ReadonlyArray<{
    toolName: string;
    toolCallId: string;
    startedAtMs: number;
    explicitDeadlineAtMs?: number;
    deadlineAtMs: number;
  }>;
  recovery?: { status: "pending" | "blocked" | "settled"; startedAtMs: number; error?: string };
}>;
export type SessionWatchdogDecision = Readonly<{
  action: "observe" | "warn" | "stop" | "expire_cleanup" | "blocked";
  reason: string;
  deadlineAtMs?: number;
}>;

/** One policy for timers, diagnostic projections and incoming-message stale checks. */
export function decideSessionWatchdog(
  snapshot: SessionWatchdogSnapshot,
  now: number,
): SessionWatchdogDecision {
  if (!snapshot.current || snapshot.phase === "settled") {
    return { action: "observe", reason: "retired" };
  }
  if (snapshot.recovery) {
    return {
      action:
        snapshot.recovery.status === "blocked" ||
        (snapshot.recovery.status === "pending" &&
          now >= snapshot.recovery.startedAtMs + SESSION_WATCHDOG_CLEANUP_MS)
          ? "blocked"
          : "observe",
      reason: snapshot.recovery.status === "settled" ? "owner_settled" : "cleanup_pending",
    };
  }
  if (snapshot.phase === "finishing" || snapshot.phase === "terminal") {
    const deadlineAtMs = snapshot.cleanupDeadlineAtMs;
    return deadlineAtMs !== undefined && now >= deadlineAtMs
      ? {
          action: "expire_cleanup",
          reason: snapshot.phase === "terminal" ? "terminal_unreleased" : "finalization_stalled",
          deadlineAtMs,
        }
      : { action: "observe", reason: "owned_cleanup", deadlineAtMs };
  }
  if (snapshot.executionDeadlineAtMs !== undefined && now >= snapshot.executionDeadlineAtMs) {
    return {
      action: "stop",
      reason: "execution_deadline",
      deadlineAtMs: snapshot.executionDeadlineAtMs,
    };
  }
  const wait = snapshot.waits.find((w) => w.deadlineAtMs === undefined || now < w.deadlineAtMs);
  if (wait) {
    return { action: "observe", reason: wait.kind, deadlineAtMs: wait.deadlineAtMs };
  }
  const deadlineAtMs = Math.max(
    snapshot.semanticDeadlineAtMs,
    ...snapshot.tools.map((tool) => tool.deadlineAtMs),
  );
  if (now >= deadlineAtMs) {
    return { action: "stop", reason: "semantic_stall", deadlineAtMs };
  }
  return now >= snapshot.semanticProgressAtMs + snapshot.warningMs
    ? { action: "warn", reason: "no_semantic_progress", deadlineAtMs }
    : { action: "observe", reason: "progress", deadlineAtMs };
}
