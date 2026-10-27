import type { SessionGoal } from "../config/sessions/types.js";

const GOAL_STATUS_LABELS = {
  active: "Pursuing goal",
  paused: "Goal paused",
  blocked: "Goal blocked",
  usage_limited: "Goal hit usage limits",
  budget_limited: "Goal unmet",
  complete: "Goal achieved",
} satisfies Record<SessionGoal["status"], string>;

const GOAL_STOP_TIMESTAMPS = {
  paused: "pausedAt",
  blocked: "blockedAt",
  usage_limited: "usageLimitedAt",
  budget_limited: "budgetLimitedAt",
  complete: "completedAt",
} as const satisfies Record<Exclude<SessionGoal["status"], "active">, keyof SessionGoal>;

function formatGoalTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }
  if (value < 1000) {
    return String(Math.round(value));
  }
  if (value < 1_000_000) {
    const rounded = value >= 10_000 ? Math.round(value / 1000) : Math.round(value / 100) / 10;
    if (rounded >= 1000) {
      return "1m";
    }
    return `${rounded}k`;
  }
  const rounded =
    value >= 10_000_000 ? Math.round(value / 1_000_000) : Math.round(value / 100_000) / 10;
  return `${rounded}m`;
}

export function formatGoalUsage(goal: SessionGoal): string | null {
  if (typeof goal.tokenBudget === "number" && Number.isFinite(goal.tokenBudget)) {
    return `${formatGoalTokenCount(goal.tokensUsed)}/${formatGoalTokenCount(goal.tokenBudget)}`;
  }
  if (goal.tokensUsed > 0) {
    return `${formatGoalTokenCount(goal.tokensUsed)} used`;
  }
  return null;
}

export function formatGoalStatusLabel(status: SessionGoal["status"]): string {
  return GOAL_STATUS_LABELS[status];
}

export function formatGoalSummary(goal: SessionGoal): string {
  const usage = formatGoalUsage(goal);
  const status = formatGoalStatusLabel(goal.status);
  return usage ? `${status} (${usage})` : status;
}

/** Wall-clock time spent on the goal; frozen at the status timestamp once not active. */
export function goalElapsedMs(goal: SessionGoal, now: number): number {
  const stoppedAt =
    goal.status === "active" ? now : (goal[GOAL_STOP_TIMESTAMPS[goal.status]] ?? goal.updatedAt);
  return Math.max(0, stoppedAt - goal.createdAt);
}

export function formatGoalElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) {
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  const days = Math.floor(hours / 24);
  const period = days >= 7 ? `${Math.floor(days / 7)}wk ${days % 7}d` : `${days}d`;
  return `${period} ${hours % 24}h ${minutes}m`;
}

export function formatGoalDetail(goal: SessionGoal): string {
  const note = goal.lastStatusNote ? ` - ${goal.lastStatusNote}` : "";
  return `${formatGoalSummary(goal)}: ${goal.objective}${note}`;
}
