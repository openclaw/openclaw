// Session goal state tracks objective progress and token budgets in the session store.
import crypto from "node:crypto";
import { formatTokenCount } from "../../utils/token-format.js";
import { emitGoalUpdated, goalToUpdatedEvent } from "./goal-events.js";
import { loadSessionEntry, patchSessionEntry } from "./session-accessor.js";
import { resolveFreshSessionTotalTokens } from "./types.js";
import type { SessionEntry, SessionGoal, SessionGoalContract, SessionGoalStatus } from "./types.js";

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
  contract?: SessionGoalContract;
};

type UpdateSessionGoalStatusOptions = SessionGoalStoreOptions & {
  status: Extract<SessionGoalStatus, "active" | "paused" | "blocked" | "complete">;
  note?: string;
  /**
   * When set, the update throws ("goal is not active") unless the stored goal is
   * currently `active`. Used by the goal driver's completion judge so a `done`
   * verdict cannot override a goal the user paused/blocked in the gap between the
   * bounded judge call and this write.
   */
  requireActiveStatus?: boolean;
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

function normalizeContractText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeContractList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

/**
 * Normalizes a caller-supplied contract into a stored contract, dropping empty
 * fields. Returns undefined when nothing survives so an all-empty contract is
 * indistinguishable from a bare free-form goal (the backwards-compatible path).
 */
export function normalizeSessionGoalContract(
  contract: SessionGoalContract | undefined,
): SessionGoalContract | undefined {
  if (!contract) {
    return undefined;
  }
  const next: SessionGoalContract = {};
  const outcome = normalizeContractText(contract.outcome);
  const verification = normalizeContractText(contract.verification);
  const constraints = normalizeContractList(contract.constraints);
  const boundaries = normalizeContractList(contract.boundaries);
  const stopWhen = normalizeContractText(contract.stopWhen);
  if (outcome) next.outcome = outcome;
  if (verification) next.verification = verification;
  if (constraints) next.constraints = constraints;
  if (boundaries) next.boundaries = boundaries;
  if (stopWhen) next.stopWhen = stopWhen;
  return Object.keys(next).length > 0 ? next : undefined;
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
      return "/goal edit <objective>, /goal pause, /goal complete, /goal clear";
    case "paused":
    case "blocked":
    case "usage_limited":
    case "budget_limited":
      return "/goal resume, /goal edit <objective>, /goal clear";
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
      loadSessionEntry({ sessionKey: options.sessionKey, storePath: options.storePath }) ??
      options.fallbackEntry;
    const projected = entry
      ? resolveSessionGoalDisplayState(entry, now, { adoptFreshBaseline: false })
      : undefined;
    return projected ? { status: "found", goal: projected } : { status: "missing" };
  }
  let goal: SessionGoal | undefined;
  const result = await patchSessionEntry(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      const accounted = accountGoalUsage(entry, now);
      goal = accounted ? cloneGoal(accounted) : undefined;
      if (!accounted || goalsEqual(accounted, entry.goal)) {
        return null;
      }
      return { goal: accounted };
    },
    { fallbackEntry: options.fallbackEntry },
  );
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
  const result = await patchSessionEntry(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      if (entry.goal) {
        throw new Error("goal already exists");
      }
      const tokenBudget = normalizeTokenBudget(options.tokenBudget);
      const tokenStartFresh = resolveEntryFreshTotalTokens(entry) !== undefined;
      const contract = normalizeSessionGoalContract(options.contract);
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
        ...(contract ? { contract } : {}),
      };
      return { goal: created };
    },
    { fallbackEntry: options.fallbackEntry },
  );
  if (!result || !created) {
    throw new Error("session not found");
  }
  emitGoalUpdated(goalToUpdatedEvent(options.sessionKey, created, "host"));
  return cloneGoal(created);
}

export async function updateSessionGoalStatus(
  options: UpdateSessionGoalStatusOptions,
): Promise<SessionGoal> {
  const now = nowMs(options.now);
  let updated: SessionGoal | undefined;
  let foundSession = false;
  const result = await patchSessionEntry(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      foundSession = true;
      const accounted = accountGoalUsage(entry, now);
      if (!accounted) {
        throw new Error("goal not found");
      }
      if (TERMINAL_GOAL_STATUSES.has(accounted.status) && accounted.status !== options.status) {
        throw new Error(`goal is already ${accounted.status}`);
      }
      // Guard for the goal driver's completion judge: never override a goal the
      // user changed away from `active` during the bounded judge call.
      if (options.requireActiveStatus && accounted.status !== "active") {
        throw new Error(`goal is not active (status: ${accounted.status})`);
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
      // A parked wait barrier is meaningless once the goal changes status: a
      // pause/block/complete abandons it, and resuming to active starts fresh.
      delete next.wait;
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
  );
  if (!result || !updated) {
    throw new Error(foundSession ? "goal not found" : "session not found");
  }
  emitGoalUpdated(goalToUpdatedEvent(options.sessionKey, updated, "host"));
  return cloneGoal(updated);
}

export async function updateSessionGoalObjective(
  options: SessionGoalStoreOptions & { objective: string; tokenBudget?: number },
): Promise<SessionGoal> {
  const objective = options.objective.trim();
  if (!objective) {
    throw new Error("objective required");
  }
  const tokenBudget = normalizeTokenBudget(options.tokenBudget);
  const now = nowMs(options.now);
  let updated: SessionGoal | undefined;
  let foundSession = false;
  const result = await patchSessionEntry(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      foundSession = true;
      const accounted = accountGoalUsage(entry, now);
      if (!accounted) {
        throw new Error("goal not found");
      }
      if (TERMINAL_GOAL_STATUSES.has(accounted.status)) {
        throw new Error(`goal is already ${accounted.status}`);
      }
      // Rewording keeps status and token accounting; only the target moves. An
      // optional budget update rides along so the edit dialog can adjust both.
      updated = {
        ...accounted,
        objective,
        ...(tokenBudget !== undefined ? { tokenBudget } : {}),
        updatedAt: now,
      };
      return { goal: updated };
    },
  );
  if (!result || !updated) {
    throw new Error(foundSession ? "goal not found" : "session not found");
  }
  emitGoalUpdated(goalToUpdatedEvent(options.sessionKey, updated, "host"));
  return cloneGoal(updated);
}

/**
 * Attaches or replaces the completion contract on an existing goal.
 *
 * Passing an all-empty (or undefined) contract clears it, returning the goal to
 * bare free-form behavior. Status and token accounting are untouched; only the
 * contract slot moves. Rejects terminal (`complete`) goals like the other
 * mutators so a finished goal is never silently re-decorated.
 */
export async function updateSessionGoalContract(
  options: SessionGoalStoreOptions & { contract: SessionGoalContract | undefined },
): Promise<SessionGoal> {
  const now = nowMs(options.now);
  const contract = normalizeSessionGoalContract(options.contract);
  let updated: SessionGoal | undefined;
  let foundSession = false;
  const result = await patchSessionEntry(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      foundSession = true;
      const accounted = accountGoalUsage(entry, now);
      if (!accounted) {
        throw new Error("goal not found");
      }
      if (TERMINAL_GOAL_STATUSES.has(accounted.status)) {
        throw new Error(`goal is already ${accounted.status}`);
      }
      const next: SessionGoal = { ...accounted, updatedAt: now };
      if (contract) {
        next.contract = contract;
      } else {
        delete next.contract;
      }
      updated = next;
      return { goal: updated };
    },
    { fallbackEntry: options.fallbackEntry },
  );
  if (!result || !updated) {
    throw new Error(foundSession ? "goal not found" : "session not found");
  }
  emitGoalUpdated(goalToUpdatedEvent(options.sessionKey, updated, "host"));
  return cloneGoal(updated);
}

/**
 * Sets a parked wait barrier on the active goal. While set and unsatisfied, the
 * goal driver quiesces without firing a continuation or consuming a no-progress
 * turn. Exactly one barrier kind is stored: a time barrier (`waitingUntil`) or a
 * session barrier (`waitingOnSessionKey`); passing both prefers the session key.
 * No-ops (returns undefined) when no `active` goal exists or neither field is
 * usable.
 */
export async function setSessionGoalWaitBarrier(
  options: SessionGoalStoreOptions & {
    waitingUntil?: number;
    waitingOnSessionKey?: string;
    reason?: string;
  },
): Promise<SessionGoal | undefined> {
  const now = nowMs(options.now);
  const waitingOnSessionKey = options.waitingOnSessionKey?.trim() || undefined;
  const waitingUntil =
    !waitingOnSessionKey &&
    typeof options.waitingUntil === "number" &&
    Number.isFinite(options.waitingUntil) &&
    options.waitingUntil > now
      ? Math.floor(options.waitingUntil)
      : undefined;
  if (!waitingOnSessionKey && waitingUntil === undefined) {
    return undefined;
  }
  const reason = options.reason?.trim() || undefined;
  let updated: SessionGoal | undefined;
  await patchSessionEntry(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      const goal = entry.goal;
      if (!goal || goal.status !== "active") {
        return null;
      }
      const wait: NonNullable<SessionGoal["wait"]> = {
        waitingSince: now,
        ...(waitingOnSessionKey
          ? { waitingOnSessionKey }
          : waitingUntil !== undefined
            ? { waitingUntil }
            : {}),
        ...(reason ? { waitingReason: reason } : {}),
      };
      updated = { ...goal, wait, updatedAt: now };
      return { goal: updated };
    },
    { fallbackEntry: options.fallbackEntry },
  );
  if (updated) {
    emitGoalUpdated(goalToUpdatedEvent(options.sessionKey, updated, "host"));
  }
  return updated ? cloneGoal(updated) : undefined;
}

/**
 * Clears any parked wait barrier from a goal. Called by the driver once a
 * barrier is satisfied (deadline passed / watched session's run ended), and by
 * the user-facing unwait path. No-ops when no barrier is set.
 */
export async function clearSessionGoalWaitBarrier(
  options: SessionGoalStoreOptions,
): Promise<SessionGoal | undefined> {
  const now = nowMs(options.now);
  let updated: SessionGoal | undefined;
  await patchSessionEntry(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      const goal = entry.goal;
      if (!goal || !goal.wait) {
        return null;
      }
      const next = { ...goal, updatedAt: now };
      delete next.wait;
      updated = next;
      return { goal: updated };
    },
    { fallbackEntry: options.fallbackEntry },
  );
  if (updated) {
    emitGoalUpdated(goalToUpdatedEvent(options.sessionKey, updated, "host"));
  }
  return updated ? cloneGoal(updated) : undefined;
}

/**
 * Increments the durable no-progress continuation counter for a session goal.
 *
 * The goal-driver calls this immediately before it fires a continuation turn so
 * the consecutive-continuation ceiling survives a gateway restart (the counter
 * is otherwise process-local). No-ops when no goal exists or the goal is not
 * `active`. Returns the updated goal, or undefined when there is nothing to
 * increment. Token accounting is intentionally NOT re-projected here — this is a
 * narrow counter write on the hot driver path, not a display read.
 */
export async function recordSessionGoalContinuation(
  options: SessionGoalStoreOptions,
): Promise<SessionGoal | undefined> {
  let updated: SessionGoal | undefined;
  await patchSessionEntry(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      const goal = entry.goal;
      if (!goal || goal.status !== "active") {
        return null;
      }
      updated = { ...goal, continuationTurns: goal.continuationTurns + 1 };
      return { goal: updated };
    },
    { fallbackEntry: options.fallbackEntry },
  );
  return updated ? cloneGoal(updated) : undefined;
}

/**
 * Resets the durable no-progress continuation counter to zero.
 *
 * Called when a real inbound (non-driver) turn completes: any genuine user
 * interaction counts as progress and re-opens the full continuation budget.
 * No-ops when no goal exists or the counter is already zero.
 */
export async function resetSessionGoalContinuations(
  options: SessionGoalStoreOptions,
): Promise<SessionGoal | undefined> {
  let updated: SessionGoal | undefined;
  await patchSessionEntry(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      const goal = entry.goal;
      if (!goal || goal.continuationTurns === 0) {
        return null;
      }
      updated = { ...goal, continuationTurns: 0 };
      return { goal: updated };
    },
    { fallbackEntry: options.fallbackEntry },
  );
  return updated ? cloneGoal(updated) : undefined;
}

export async function clearSessionGoal(options: SessionGoalStoreOptions): Promise<boolean> {
  let removed = false;
  const result = await patchSessionEntry(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      if (!entry.goal) {
        return null;
      }
      removed = true;
      return { goal: undefined };
    },
  );
  const cleared = Boolean(result && removed);
  if (cleared) {
    emitGoalUpdated(goalToUpdatedEvent(options.sessionKey, undefined, "host"));
  }
  return cleared;
}
