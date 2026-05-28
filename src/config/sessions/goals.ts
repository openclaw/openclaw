import crypto from "node:crypto";
import { patchSessionEntry } from "./store.js";
import { resolveFreshSessionTotalTokens } from "./types.js";
import type { SessionEntry, SessionGoal, SessionGoalStatus } from "./types.js";

export type SessionGoalSnapshot = {
  status: "missing" | "found";
  goal?: SessionGoal;
};

type SessionGoalStoreOptions = {
  sessionKey: string;
  storePath?: string;
  now?: number;
  fallbackEntry?: SessionEntry;
};

type CreateSessionGoalOptions = SessionGoalStoreOptions & {
  objective: string;
  tokenBudget?: number;
};

type UpdateSessionGoalStatusOptions = SessionGoalStoreOptions & {
  status: Extract<SessionGoalStatus, "active" | "paused" | "blocked" | "complete">;
  note?: string;
};

export const MODEL_UPDATABLE_SESSION_GOAL_STATUSES = ["complete", "blocked"] as const;

const TERMINAL_GOAL_STATUSES = new Set<SessionGoalStatus>(["blocked", "complete"]);

function nowMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function normalizeTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function resolveEntryFreshTotalTokens(
  entry: Pick<SessionEntry, "totalTokens" | "totalTokensFresh">,
): number | undefined {
  return normalizeTokenCount(resolveFreshSessionTotalTokens(entry));
}

function resolveEntryGoalStartTokens(
  entry: Pick<SessionEntry, "totalTokens" | "totalTokensFresh">,
): number {
  return resolveEntryFreshTotalTokens(entry) ?? 0;
}

function normalizeTokenBudget(value: number | undefined): number | undefined {
  const normalized = normalizeTokenCount(value);
  return normalized && normalized > 0 ? normalized : undefined;
}

function cloneGoal(goal: SessionGoal): SessionGoal {
  return { ...goal };
}

function accountGoalUsage(entry: SessionEntry, now: number): SessionGoal | undefined {
  const goal = entry.goal;
  if (!goal) {
    return undefined;
  }
  const totalTokens = resolveEntryFreshTotalTokens(entry);
  const tokenStart = normalizeTokenCount(goal.tokenStart) ?? totalTokens ?? 0;
  const tokensUsed =
    totalTokens === undefined
      ? goal.tokensUsed
      : Math.max(goal.tokensUsed, Math.max(0, totalTokens - tokenStart));
  const next: SessionGoal = {
    ...goal,
    tokenStart,
    tokensUsed,
  };
  if (
    next.status === "active" &&
    next.tokenBudget !== undefined &&
    tokensUsed >= next.tokenBudget
  ) {
    next.status = "budget_limited";
    next.budgetLimitedAt = now;
    next.updatedAt = now;
  }
  return next;
}

function goalsEqual(a: SessionGoal | undefined, b: SessionGoal | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function formatSessionGoalStatus(goal: SessionGoal | undefined): string {
  if (!goal) {
    return "No active goal.";
  }
  const budget =
    goal.tokenBudget === undefined ? "" : `\nToken budget: ${goal.tokensUsed}/${goal.tokenBudget}`;
  const note = goal.lastStatusNote ? `\nNote: ${goal.lastStatusNote}` : "";
  return `Goal: ${goal.objective}\nStatus: ${goal.status}\nTokens used: ${goal.tokensUsed}${budget}${note}`;
}

export async function getSessionGoal(
  options: SessionGoalStoreOptions,
): Promise<SessionGoalSnapshot> {
  const now = nowMs(options.now);
  let goal: SessionGoal | undefined;
  const result = await patchSessionEntry({
    sessionKey: options.sessionKey,
    storePath: options.storePath,
    fallbackEntry: options.fallbackEntry,
    update: (entry) => {
      const accounted = accountGoalUsage(entry, now);
      goal = accounted ? cloneGoal(accounted) : undefined;
      if (!accounted || goalsEqual(accounted, entry.goal)) {
        return null;
      }
      return { goal: accounted };
    },
  });
  if (!result || !goal) {
    return { status: "missing" };
  }
  return { status: "found", goal };
}

export async function createSessionGoal(options: CreateSessionGoalOptions): Promise<SessionGoal> {
  const objective = options.objective.trim();
  if (!objective) {
    throw new Error("objective required");
  }
  const now = nowMs(options.now);
  let created: SessionGoal | undefined;
  const result = await patchSessionEntry({
    sessionKey: options.sessionKey,
    storePath: options.storePath,
    fallbackEntry: options.fallbackEntry,
    update: (entry) => {
      if (entry.goal) {
        throw new Error("goal already exists");
      }
      const tokenBudget = normalizeTokenBudget(options.tokenBudget);
      created = {
        schemaVersion: 1,
        id: crypto.randomUUID(),
        objective,
        status: "active",
        createdAt: now,
        updatedAt: now,
        tokenStart: resolveEntryGoalStartTokens(entry),
        tokensUsed: 0,
        ...(tokenBudget ? { tokenBudget } : {}),
        continuationTurns: 0,
      };
      return { goal: created };
    },
  });
  if (!result || !created) {
    throw new Error("session not found");
  }
  return cloneGoal(created);
}

export async function updateSessionGoalStatus(
  options: UpdateSessionGoalStatusOptions,
): Promise<SessionGoal> {
  const now = nowMs(options.now);
  let updated: SessionGoal | undefined;
  const result = await patchSessionEntry({
    sessionKey: options.sessionKey,
    storePath: options.storePath,
    update: (entry) => {
      const accounted = accountGoalUsage(entry, now);
      if (!accounted) {
        throw new Error("goal not found");
      }
      if (TERMINAL_GOAL_STATUSES.has(accounted.status) && accounted.status !== options.status) {
        throw new Error(`goal is already ${accounted.status}`);
      }
      updated = {
        ...accounted,
        status: options.status,
        updatedAt: now,
        ...(options.note ? { lastStatusNote: options.note } : {}),
        ...(options.status === "paused" ? { pausedAt: now } : {}),
        ...(options.status === "blocked" ? { blockedAt: now } : {}),
        ...(options.status === "complete" ? { completedAt: now } : {}),
      };
      return { goal: updated };
    },
  });
  if (!result || !updated) {
    throw new Error("session not found");
  }
  return cloneGoal(updated);
}

export async function clearSessionGoal(options: SessionGoalStoreOptions): Promise<boolean> {
  let removed = false;
  const result = await patchSessionEntry({
    sessionKey: options.sessionKey,
    storePath: options.storePath,
    update: (entry) => {
      if (!entry.goal) {
        return null;
      }
      removed = true;
      return { goal: undefined };
    },
  });
  return Boolean(result && removed);
}
