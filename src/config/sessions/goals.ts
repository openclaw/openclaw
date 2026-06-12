// Session goal state tracks objective progress and token budgets in the session store.
import crypto from "node:crypto";
import { getSessionEntry, patchSessionEntry } from "./store.js";
import { resolveFreshSessionTotalTokens } from "./types.js";
import type { ClearedGoal, SessionEntry, SessionGoal, SessionGoalStatus } from "./types.js";

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

function formatGoalTokenCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "0";
  }
  const safe = Math.max(0, value);
  if (safe >= 1_000_000) {
    return `${(safe / 1_000_000).toFixed(1)}m`;
  }
  if (safe >= 1_000) {
    const precision = safe >= 10_000 ? 0 : 1;
    const formattedThousands = (safe / 1_000).toFixed(precision);
    if (Number(formattedThousands) >= 1_000) {
      return `${(safe / 1_000_000).toFixed(1)}m`;
    }
    return `${formattedThousands}k`;
  }
  return String(Math.round(safe));
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
  // `goal` is introduced here as a core-owned slot; no shipped plugin-owned
  // goal state exists to migrate, and plugin slot registration now reserves it.
  const goal = entry.goal;
  if (!goal) {
    return undefined;
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
      : `\nToken budget: ${formatGoalTokenCount(goal.tokensUsed)}/${formatGoalTokenCount(goal.tokenBudget)}`;
  const note = goal.lastStatusNote ? `\nNote: ${goal.lastStatusNote}` : "";
  const commands = resolveGoalCommandHint(goal.status);
  return [
    "Goal",
    `Status: ${goal.status}`,
    `Objective: ${goal.objective}`,
    `Tokens used: ${formatGoalTokenCount(goal.tokensUsed)}`,
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
    // Status rendering should not write incidental budget/baseline adoption unless callers opt in.
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
  let foundSession = false;
  const result = await patchSessionEntry({
    sessionKey: options.sessionKey,
    storePath: options.storePath,
    update: (entry) => {
      foundSession = true;
      const accounted = accountGoalUsage(entry, now);
      if (!accounted) {
        throw new Error("goal not found");
      }
      if (TERMINAL_GOAL_STATUSES.has(accounted.status) && accounted.status !== options.status) {
        throw new Error(`goal is already ${accounted.status}`);
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
        ...(options.status === "complete" ? { completedAt: now } : {}),
      };
      if (resetsBudgetWindow) {
        next.tokenStart = freshTokenStart ?? 0;
        next.tokenStartFresh = freshTokenStart !== undefined;
        next.tokensUsed = 0;
        delete next.budgetLimitedAt;
        delete next.usageLimitedAt;
      }
      if (
        next.status === "active" &&
        next.tokenBudget !== undefined &&
        next.tokensUsed >= next.tokenBudget
      ) {
        next.status = "budget_limited";
        next.budgetLimitedAt = now;
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
      if (!entry.goal) {
        return null;
      }
      removed = true;
      return { goal: undefined };
    },
  });
  return Boolean(result && removed);
}

/**
 * Goals in any of these states can be cleared by an explicit `clear_goal` call.
 * Mirrors the non-active states listed in resolveGoalCommandHint() in goals.ts.
 * The set is intentionally a SUPERSET of `TERMINAL_GOAL_STATUSES` (which is
 * `complete` only) because the model-controlled clear is allowed to rotate
 * `paused`/`blocked`/`usage_limited`/`budget_limited` goals too, while
 * `createSessionGoal` still treats them as a creation blocker.
 */
export const CLEARABLE_GOAL_STATUSES: ReadonlySet<SessionGoalStatus> = new Set<SessionGoalStatus>([
  "complete",
  "blocked",
  "paused",
  "usage_limited",
  "budget_limited",
]);

/**
 * Result of a clear-and-archive transition. The cleared snapshot is
 * returned to the caller so the tool layer can echo it back in its
 * `jsonResult` payload without an extra `getSessionGoal` round-trip.
 */
export type ClearAndArchiveResult = {
  /** The cleared goal snapshot (frozen copy from the canonical store). */
  cleared: ClearedGoal;
  /** True if the goal was in a clearable state; false if nothing to clear. */
  wasCleared: boolean;
};

/**
 * Atomic clear-and-archive transition.
 *
 * Removes the current goal from `entry.goal` and appends a `ClearedGoal`
 * snapshot to `entry.clearedGoals` in ONE `patchSessionEntry` call. The
 * store is mutex-protected (`runExclusiveSessionStoreWrite`) and persisted
 * via `persistResolvedSessionEntry` (write-temp-then-rename), so the
 * transition is observably atomic from any other reader.
 *
 * Refuses to clear an `active` goal. Active goals are reserved for
 * operator/session control per the documented lifecycle contract.
 *
 * `clearedGoals` is bounded to `clearRetained` (default 50) and pruned
 * oldest-first on each insert. The default is configurable via the
 * `clearedGoalsRetained` field on the session store config; this function
 * reads it from the current entry's effective config (or uses the default).
 */
export type ClearAndArchiveOptions = SessionGoalStoreOptions & {
  /** Optional caller-supplied note attached to the archive entry. */
  note?: string;
  /** Max retained cleared goals (default 50). Older entries are pruned. */
  clearRetained?: number;
  /**
   * If true (default), throw on a non-clearable status. If false, return
   * `{ wasCleared: false }` instead. The tool layer uses true to surface
   * a clear error to the model.
   */
  rejectNonClearable?: boolean;
};

const DEFAULT_CLEAR_RETAINED = 50;

export class ClearGoalRejectedError extends Error {
  readonly currentStatus: SessionGoalStatus;
  constructor(currentStatus: SessionGoalStatus) {
    super(
      `clear_goal refused: goal is in status '${currentStatus}'; only clearable states are ${Array.from(
        CLEARABLE_GOAL_STATUSES,
      ).join(", ")}`,
    );
    this.name = "ClearGoalRejectedError";
    this.currentStatus = currentStatus;
  }
}

export async function clearAndArchiveSessionGoal(
  options: ClearAndArchiveOptions,
): Promise<ClearAndArchiveResult> {
  const clearRetained =
    options.clearRetained && options.clearRetained > 0
      ? Math.floor(options.clearRetained)
      : DEFAULT_CLEAR_RETAINED;
  const reject = options.rejectNonClearable !== false;
  const now = nowMs(options.now);
  let captured: ClearedGoal | undefined;
  let nothingToClear = false;

  const result = await patchSessionEntry({
    sessionKey: options.sessionKey,
    storePath: options.storePath,
    update: (entry) => {
      if (!entry.goal) {
        nothingToClear = true;
        return null;
      }
      if (!CLEARABLE_GOAL_STATUSES.has(entry.goal.status)) {
        if (reject) {
          throw new ClearGoalRejectedError(entry.goal.status);
        }
        nothingToClear = true;
        return null;
      }
      const snapshot: ClearedGoal = {
        id: entry.goal.id,
        objective: entry.goal.objective,
        clearedFromStatus: entry.goal.status,
        clearedAt: now,
        createdAt: entry.goal.createdAt,
        updatedAt: entry.goal.updatedAt,
        tokensUsed: entry.goal.tokensUsed,
        ...(entry.goal.tokenBudget !== undefined ? { tokenBudget: entry.goal.tokenBudget } : {}),
        ...(entry.goal.lastStatusNote !== undefined
          ? { lastStatusNote: entry.goal.lastStatusNote }
          : {}),
        ...(options.note ? { clearNote: options.note } : {}),
      };
      captured = snapshot;
      // Prune oldest-first to bound the array.
      const existingCleared = entry.clearedGoals ?? [];
      const merged = [...existingCleared, snapshot];
      const pruned =
        merged.length > clearRetained ? merged.slice(merged.length - clearRetained) : merged;
      return {
        goal: undefined,
        clearedGoals: pruned,
      };
    },
  });

  if (!result) {
    // Session entry itself is missing — nothing to clear.
    return { cleared: undefined as unknown as ClearedGoal, wasCleared: false };
  }
  if (nothingToClear) {
    return { cleared: undefined as unknown as ClearedGoal, wasCleared: false };
  }
  return { cleared: captured as ClearedGoal, wasCleared: true };
}
