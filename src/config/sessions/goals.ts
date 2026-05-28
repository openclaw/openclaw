import crypto from "node:crypto";
import { formatTokenCount } from "../../utils/usage-format.js";
import { getSessionEntry, patchSessionEntry } from "./store.js";
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
  persist?: boolean;
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

const SESSION_GOAL_STATUSES = new Set<SessionGoalStatus>([
  "active",
  "paused",
  "blocked",
  "usage_limited",
  "budget_limited",
  "complete",
]);
const TERMINAL_GOAL_STATUSES = new Set<SessionGoalStatus>(["complete"]);

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

function hasOwnGoalSlot(entry: Pick<SessionEntry, "goal">): boolean {
  return Object.prototype.hasOwnProperty.call(entry, "goal");
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOptionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined || isNonNegativeNumber(value);
}

function isSessionGoal(value: unknown): value is SessionGoal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const goal = value as Partial<SessionGoal>;
  return (
    goal.schemaVersion === 1 &&
    typeof goal.id === "string" &&
    goal.id.length > 0 &&
    typeof goal.objective === "string" &&
    goal.objective.length > 0 &&
    typeof goal.status === "string" &&
    SESSION_GOAL_STATUSES.has(goal.status) &&
    isNonNegativeNumber(goal.createdAt) &&
    isNonNegativeNumber(goal.updatedAt) &&
    isNonNegativeNumber(goal.tokenStart) &&
    (goal.tokenStartFresh === undefined || typeof goal.tokenStartFresh === "boolean") &&
    isNonNegativeNumber(goal.tokensUsed) &&
    (goal.tokenBudget === undefined ||
      (isNonNegativeNumber(goal.tokenBudget) && goal.tokenBudget > 0)) &&
    isNonNegativeNumber(goal.continuationTurns) &&
    (goal.lastStatusNote === undefined || typeof goal.lastStatusNote === "string") &&
    isOptionalNonNegativeNumber(goal.pausedAt) &&
    isOptionalNonNegativeNumber(goal.blockedAt) &&
    isOptionalNonNegativeNumber(goal.completedAt) &&
    isOptionalNonNegativeNumber(goal.usageLimitedAt) &&
    isOptionalNonNegativeNumber(goal.budgetLimitedAt)
  );
}

function getCoreGoal(entry: Pick<SessionEntry, "goal">): SessionGoal | undefined {
  const value = (entry as { goal?: unknown }).goal;
  return isSessionGoal(value) ? value : undefined;
}

function pruneLegacyGoalSlotKeys(
  slotKeys: SessionEntry["pluginExtensionSlotKeys"],
): SessionEntry["pluginExtensionSlotKeys"] | undefined {
  if (!slotKeys) {
    return undefined;
  }
  let changed = false;
  const next: NonNullable<SessionEntry["pluginExtensionSlotKeys"]> = {};
  for (const [pluginId, namespaceSlots] of Object.entries(slotKeys)) {
    const keptSlots: Record<string, string> = {};
    for (const [namespace, slotKey] of Object.entries(namespaceSlots)) {
      if (slotKey.trim() === "goal") {
        changed = true;
        continue;
      }
      keptSlots[namespace] = slotKey;
    }
    if (Object.keys(keptSlots).length > 0) {
      next[pluginId] = keptSlots;
    } else {
      changed = true;
    }
  }
  if (!changed) {
    return slotKeys;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function buildLegacyGoalCleanupPatch(
  entry: Pick<SessionEntry, "goal" | "pluginExtensionSlotKeys">,
): Partial<SessionEntry> | null {
  if (!hasOwnGoalSlot(entry) || getCoreGoal(entry)) {
    return null;
  }
  return {
    goal: undefined,
    pluginExtensionSlotKeys: pruneLegacyGoalSlotKeys(entry.pluginExtensionSlotKeys),
  };
}

export function resolveSessionGoalDisplayState(
  entry: Pick<SessionEntry, "goal" | "totalTokens" | "totalTokensFresh">,
  now?: number,
  options?: { adoptFreshBaseline?: boolean },
): SessionGoal | undefined {
  return accountGoalUsage(entry, nowMs(now), options);
}

function accountGoalUsage(
  entry: Pick<SessionEntry, "goal" | "totalTokens" | "totalTokensFresh">,
  now: number,
  options?: { adoptFreshBaseline?: boolean },
): SessionGoal | undefined {
  const goal = getCoreGoal(entry);
  if (!goal) {
    return undefined;
  }
  const totalTokens = resolveEntryFreshTotalTokens(entry);
  const hasFreshStart = goal.tokenStartFresh !== false;
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
  const next: SessionGoal = {
    ...goal,
    tokenStart,
    tokenStartFresh: hasFreshStart || shouldAdoptFreshStart,
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
    return "No goal for this session.\nStart one with /goal start <objective>.";
  }
  const budget =
    goal.tokenBudget === undefined
      ? ""
      : `\nToken budget: ${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget)}`;
  const note = goal.lastStatusNote ? `\nNote: ${goal.lastStatusNote}` : "";
  const commands = resolveGoalCommandHint(goal.status);
  return [
    "Goal",
    `Status: ${goal.status}`,
    `Objective: ${goal.objective}`,
    `Tokens used: ${formatTokenCount(goal.tokensUsed)}`,
    ...(budget ? [budget.slice(1)] : []),
    ...(note ? [note.slice(1)] : []),
    "",
    `Commands: ${commands}`,
  ].join("\n");
}

function resolveGoalCommandHint(status: SessionGoalStatus): string {
  switch (status) {
    case "active":
      return "/goal pause, /goal complete, /goal clear";
    case "paused":
    case "blocked":
    case "usage_limited":
    case "budget_limited":
      return "/goal resume, /goal clear";
    case "complete":
      return "/goal clear";
  }
  return "/goal";
}

export async function getSessionGoal(
  options: SessionGoalStoreOptions,
): Promise<SessionGoalSnapshot> {
  const now = nowMs(options.now);
  if (options.persist === false) {
    const entry =
      getSessionEntry({ sessionKey: options.sessionKey, storePath: options.storePath }) ??
      options.fallbackEntry;
    const projected = entry
      ? resolveSessionGoalDisplayState(entry, now, { adoptFreshBaseline: false })
      : undefined;
    return projected ? { status: "found", goal: projected } : { status: "missing" };
  }
  let goal: SessionGoal | undefined;
  const result = await patchSessionEntry({
    sessionKey: options.sessionKey,
    storePath: options.storePath,
    fallbackEntry: options.fallbackEntry,
    update: (entry) => {
      const accounted = accountGoalUsage(entry, now);
      goal = accounted ? cloneGoal(accounted) : undefined;
      const cleanupPatch = buildLegacyGoalCleanupPatch(entry);
      if (!accounted || goalsEqual(accounted, entry.goal)) {
        return cleanupPatch;
      }
      return { ...cleanupPatch, goal: accounted };
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
      if (getCoreGoal(entry)) {
        throw new Error("goal already exists");
      }
      const cleanupPatch = buildLegacyGoalCleanupPatch(entry);
      const tokenBudget = normalizeTokenBudget(options.tokenBudget);
      const tokenStartFresh = resolveEntryFreshTotalTokens(entry) !== undefined;
      created = {
        schemaVersion: 1,
        id: crypto.randomUUID(),
        objective,
        status: "active",
        createdAt: now,
        updatedAt: now,
        tokenStart: resolveEntryGoalStartTokens(entry),
        tokenStartFresh,
        tokensUsed: 0,
        ...(tokenBudget ? { tokenBudget } : {}),
        continuationTurns: 0,
      };
      return { ...cleanupPatch, goal: created };
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
  let foundSession = false;
  const result = await patchSessionEntry({
    sessionKey: options.sessionKey,
    storePath: options.storePath,
    update: (entry) => {
      foundSession = true;
      const accounted = accountGoalUsage(entry, now);
      if (!accounted) {
        const cleanupPatch = buildLegacyGoalCleanupPatch(entry);
        if (cleanupPatch) {
          return cleanupPatch;
        }
        throw new Error("goal not found");
      }
      if (TERMINAL_GOAL_STATUSES.has(accounted.status) && accounted.status !== options.status) {
        throw new Error(`goal is already ${accounted.status}`);
      }
      const resetsBudgetWindow =
        options.status === "active" &&
        (accounted.status === "budget_limited" || accounted.status === "usage_limited");
      const freshTokenStart = resetsBudgetWindow ? resolveEntryFreshTotalTokens(entry) : undefined;
      const next: SessionGoal = {
        ...accounted,
        status: options.status,
        updatedAt: now,
        ...(options.note ? { lastStatusNote: options.note } : {}),
        ...(options.status === "paused" ? { pausedAt: now } : {}),
        ...(options.status === "blocked" ? { blockedAt: now } : {}),
        ...(options.status === "complete" ? { completedAt: now } : {}),
      };
      if (resetsBudgetWindow) {
        next.tokenStart = freshTokenStart ?? 0;
        next.tokenStartFresh = freshTokenStart !== undefined;
        next.tokensUsed = 0;
        delete next.budgetLimitedAt;
        delete next.usageLimitedAt;
      }
      updated = next;
      return { goal: updated };
    },
  });
  if (!result || !updated) {
    throw new Error(foundSession ? "goal not found" : "session not found");
  }
  return cloneGoal(updated);
}

export async function clearSessionGoal(options: SessionGoalStoreOptions): Promise<boolean> {
  let removed = false;
  const result = await patchSessionEntry({
    sessionKey: options.sessionKey,
    storePath: options.storePath,
    update: (entry) => {
      if (!hasOwnGoalSlot(entry)) {
        return null;
      }
      removed = true;
      return {
        goal: undefined,
        pluginExtensionSlotKeys: pruneLegacyGoalSlotKeys(entry.pluginExtensionSlotKeys),
      };
    },
  });
  return Boolean(result && removed);
}
