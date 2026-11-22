import crypto from "node:crypto";
import { toDiagnosticUsage, type NormalizedUsage } from "../../agents/usage.js";
import { resolveFreshSessionTotalTokens } from "./types.js";
import type { SessionEntry, SessionGoal, SessionGoalStatus } from "./types.js";

export class SessionGoalTransitionError extends Error {
  override name = "SessionGoalTransitionError";
}

function normalizeTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function resolveEntryFreshTotalTokens(
  entry: Pick<SessionEntry, "totalTokens" | "totalTokensFresh" | "totalTokensVersion">,
): number | undefined {
  return normalizeTokenCount(resolveFreshSessionTotalTokens(entry));
}

function normalizeTokenBudget(value: number | undefined): number | undefined {
  const normalized = normalizeTokenCount(value);
  return normalized && normalized > 0 ? normalized : undefined;
}

export function accountSessionGoalUsage(
  entry: Pick<
    SessionEntry,
    "goal" | "agentHarnessId" | "totalTokens" | "totalTokensFresh" | "totalTokensVersion"
  >,
  now: number,
  options?: { adoptFreshBaseline?: boolean },
): SessionGoal | undefined {
  const goal = entry.goal;
  if (!goal) {
    return undefined;
  }
  // Built-in budgets use committed consumption, not the latest context size.
  if (
    goal.tokenBudget !== undefined &&
    (entry.agentHarnessId === undefined || entry.agentHarnessId === "openclaw")
  ) {
    return limitSessionGoalBudget(goal, now);
  }
  const totalTokens = resolveEntryFreshTotalTokens(entry);
  const hasFreshStart = goal.tokenStartFresh !== false;
  // Old entries may have a stale token baseline; display-only reads can hold it, while persisted
  // reads adopt the fresh total so future budget checks use current accounting.
  const shouldHoldStaleStart = !hasFreshStart && options?.adoptFreshBaseline === false;
  const shouldAdoptFreshStart =
    !shouldHoldStaleStart && totalTokens !== undefined && !hasFreshStart;
  const tokenStart = shouldAdoptFreshStart
    ? totalTokens
    : (normalizeTokenCount(goal.tokenStart) ?? totalTokens ?? 0);
  const tokensUsed =
    totalTokens === undefined || shouldAdoptFreshStart || shouldHoldStaleStart
      ? goal.tokensUsed
      : Math.max(goal.tokensUsed, Math.max(0, totalTokens - tokenStart));
  return limitSessionGoalBudget(
    {
      ...goal,
      tokenStart,
      tokenStartFresh: hasFreshStart || shouldAdoptFreshStart,
      tokensUsed,
    },
    now,
  );
}

function limitSessionGoalBudget(goal: SessionGoal, now: number): SessionGoal {
  if (
    goal.status === "active" &&
    goal.tokenBudget !== undefined &&
    goal.tokensUsed >= goal.tokenBudget
  ) {
    return { ...goal, status: "budget_limited", budgetLimitedAt: now, updatedAt: now };
  }
  return goal;
}

export type SessionGoalBudgetAdmission = Pick<SessionGoal, "id" | "tokensUsed">;

/** Aggregate model consumption, not the context observation from the last call. */
export function resolveSettledSessionGoalTokens(
  usage: NormalizedUsage | undefined,
): number | undefined {
  if (!usage || usage.usageReport?.state === "unavailable") {
    return undefined;
  }
  const total = toDiagnosticUsage(usage).total;
  return total > 0 || usage.usageReport?.state === "available" ? total : undefined;
}

export function captureSessionGoalBudget(
  goal?: SessionGoal,
): SessionGoalBudgetAdmission | undefined {
  return goal?.status === "active" && goal.tokenBudget !== undefined
    ? { id: goal.id, tokensUsed: goal.tokensUsed }
    : undefined;
}

export function applySettledSessionGoalUsage(
  goal: SessionGoal | undefined,
  admitted: SessionGoalBudgetAdmission,
  tokens: number | undefined,
  now: number,
): SessionGoal | undefined {
  // The turn owner fences the writer. The admission tally makes applying the same
  // settlement again a no-op, without introducing a second durable receipt.
  if (
    goal?.id !== admitted.id ||
    goal.tokenBudget === undefined ||
    goal.tokensUsed !== admitted.tokensUsed
  ) {
    return undefined;
  }
  if (tokens === undefined) {
    return goal.status === "active"
      ? {
          ...goal,
          status: "usage_limited",
          usageLimitedAt: now,
          updatedAt: now,
          lastStatusNote:
            "Goal token usage was unavailable. Choose a built-in model that reports usage, then resume the Goal.",
        }
      : undefined;
  }
  return tokens > 0
    ? limitSessionGoalBudget({ ...goal, tokensUsed: goal.tokensUsed + tokens }, now)
    : undefined;
}

export function buildCreatedSessionGoal(
  entry: SessionEntry,
  options: { objective: string; tokenBudget?: number },
  now: number,
): SessionGoal {
  const objective = options.objective;
  if (!objective.trim()) {
    throw new SessionGoalTransitionError("objective required");
  }
  // A completed objective no longer blocks the next explicitly requested goal.
  // Unfinished goals retain their status, budget, and operator-owned controls.
  if (entry.goal && entry.goal.status !== "complete") {
    throw new SessionGoalTransitionError("goal already exists");
  }
  const tokenBudget = normalizeTokenBudget(options.tokenBudget);
  const tokenStart = resolveEntryFreshTotalTokens(entry);
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    objective,
    status: "active",
    createdAt: now,
    updatedAt: now,
    tokenStart: tokenStart ?? 0,
    tokenStartFresh: tokenStart !== undefined,
    tokensUsed: 0,
    ...(tokenBudget ? { tokenBudget } : {}),
    continuationTurns: 0,
  };
}

export function buildUpdatedSessionGoalStatus(
  entry: SessionEntry,
  options: {
    status: Extract<SessionGoalStatus, "active" | "paused" | "blocked" | "complete">;
    note?: string;
  },
  now: number,
): SessionGoal {
  const accounted = accountSessionGoalUsage(entry, now);
  if (!accounted) {
    throw new SessionGoalTransitionError("goal not found");
  }
  if (
    accounted.status === "complete" &&
    options.status !== "complete" &&
    options.status !== "active"
  ) {
    throw new SessionGoalTransitionError(`goal is already ${accounted.status}`);
  }
  const resetsBudgetWindow =
    options.status === "active" &&
    (accounted.status === "budget_limited" ||
      accounted.status === "usage_limited" ||
      (accounted.tokenBudget !== undefined && accounted.tokensUsed >= accounted.tokenBudget));
  // Resuming from a limited state starts a new budget window at the current fresh token count.
  const freshTokenStart = resetsBudgetWindow ? resolveEntryFreshTotalTokens(entry) : undefined;
  const next: SessionGoal = {
    ...accounted,
    status: options.status,
    updatedAt: now,
    ...(options.note ? { lastStatusNote: options.note } : {}),
    ...(options.status === "paused" ? { pausedAt: now } : {}),
    ...(options.status === "blocked" ? { blockedAt: now } : {}),
    ...(options.status === "complete" ? { completedAt: accounted.completedAt ?? now } : {}),
  };
  if (accounted.status === "complete" && options.status === "active") {
    // Completion belongs to the finished pursuit; a later completion needs its own timestamp.
    delete next.completedAt;
  }
  if (resetsBudgetWindow) {
    next.tokenStart = freshTokenStart ?? 0;
    next.tokenStartFresh = freshTokenStart !== undefined;
    next.tokensUsed = 0;
    delete next.budgetLimitedAt;
    delete next.usageLimitedAt;
    if (accounted.status === "usage_limited" && options.note === undefined) {
      delete next.lastStatusNote;
    }
  }
  if (
    next.status === "active" &&
    next.tokenBudget !== undefined &&
    next.tokensUsed >= next.tokenBudget
  ) {
    next.status = "budget_limited";
    next.budgetLimitedAt = now;
  }
  return next;
}

export function buildUpdatedSessionGoalObjective(
  entry: SessionEntry,
  objective: string,
  now: number,
): SessionGoal {
  if (!objective.trim()) {
    throw new SessionGoalTransitionError("objective required");
  }
  const accounted = accountSessionGoalUsage(entry, now);
  if (!accounted) {
    throw new SessionGoalTransitionError("goal not found");
  }
  if (accounted.status === "complete") {
    throw new SessionGoalTransitionError(`goal is already ${accounted.status}`);
  }
  // Rewording keeps status and token accounting; only the target moves.
  return { ...accounted, objective, updatedAt: now };
}
