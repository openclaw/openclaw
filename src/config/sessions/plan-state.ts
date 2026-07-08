// Session plan-mode state tracks the Codex-parity plan lifecycle in the session store.
// Mirrors the core-owned goal slot: a durable slot on the session entry, absence == inactive.
import { patchSessionEntry } from "./session-accessor.js";
import type { SessionEntry, SessionPlanState, SessionPlanStatus } from "./types.js";

export type PlanLifecycleStatus = "inactive" | SessionPlanStatus;

export type SessionPlanSnapshot = {
  status: PlanLifecycleStatus;
  plan?: SessionPlanState;
};

type PlanStateStoreOptions = {
  sessionKey: string;
  storePath?: string;
  now?: number;
  fallbackEntry?: SessionEntry;
};

function nowMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function clonePlan(plan: SessionPlanState): SessionPlanState {
  return { ...plan };
}

function snapshotOf(plan: SessionPlanState | undefined): SessionPlanSnapshot {
  return plan ? { status: plan.status, plan: clonePlan(plan) } : { status: "inactive" };
}

/** Reads the current plan-mode snapshot without mutating the store. */
export function resolveSessionPlanState(
  entry: Pick<SessionEntry, "plan"> | undefined,
): SessionPlanSnapshot {
  return snapshotOf(entry?.plan);
}

/** Reads the current plan-mode state for a session from the store. */
export async function getSessionPlanState(
  options: PlanStateStoreOptions,
): Promise<SessionPlanSnapshot> {
  let snapshot: SessionPlanSnapshot = { status: "inactive" };
  await patchSessionEntry(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      snapshot = snapshotOf(entry.plan);
      // Read-only: never write on a plain status read.
      return null;
    },
    { fallbackEntry: options.fallbackEntry },
  );
  return snapshot;
}

/**
 * Enters plan mode (inactive|planning -> planning). Idempotent while already planning.
 * Rejects entering while an approval is pending; the model must resolve it first.
 */
export async function enterPlanMode(options: PlanStateStoreOptions): Promise<SessionPlanState> {
  const now = nowMs(options.now);
  let result: SessionPlanState | undefined;
  const patched = await patchSessionEntry(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      const existing = entry.plan;
      if (existing?.status === "pending_approval") {
        throw new Error("plan is awaiting approval");
      }
      if (existing?.status === "planning") {
        result = existing;
        return null;
      }
      const next: SessionPlanState = {
        schemaVersion: 1,
        status: "planning",
        enteredAt: now,
        updatedAt: now,
      };
      result = next;
      return { plan: next };
    },
    { fallbackEntry: options.fallbackEntry },
  );
  if (!result || (!patched && result.status !== "planning")) {
    throw new Error("session not found");
  }
  return clonePlan(result);
}

/**
 * Transitions planning -> pending_approval, recording the persisted plan file, the pending
 * approval question id, and the presented summary.
 */
export async function setPlanPendingApproval(
  options: PlanStateStoreOptions & {
    planFilePath: string;
    pendingQuestionId: string;
    summary?: string;
  },
): Promise<SessionPlanState> {
  const now = nowMs(options.now);
  let updated: SessionPlanState | undefined;
  const patched = await patchSessionEntry(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      const existing = entry.plan;
      if (!existing) {
        throw new Error("not in plan mode");
      }
      const next: SessionPlanState = {
        ...existing,
        status: "pending_approval",
        updatedAt: now,
        planFilePath: options.planFilePath,
        pendingQuestionId: options.pendingQuestionId,
        ...(options.summary ? { lastSummary: options.summary } : {}),
      };
      delete next.lastFeedback;
      updated = next;
      return { plan: next };
    },
    { fallbackEntry: options.fallbackEntry },
  );
  if (!patched || !updated) {
    throw new Error("session not found");
  }
  return clonePlan(updated);
}

/** Resolves an approved plan: pending_approval|planning -> inactive (clears the slot). */
export async function clearPlanState(options: PlanStateStoreOptions): Promise<boolean> {
  let removed = false;
  const patched = await patchSessionEntry(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      if (!entry.plan) {
        return null;
      }
      removed = true;
      return { plan: undefined };
    },
    { fallbackEntry: options.fallbackEntry },
  );
  return Boolean(patched && removed);
}

/** Rejects the pending plan: pending_approval -> planning, storing the revise feedback. */
export async function revisePlanMode(
  options: PlanStateStoreOptions & { feedback?: string },
): Promise<SessionPlanState> {
  const now = nowMs(options.now);
  let updated: SessionPlanState | undefined;
  const patched = await patchSessionEntry(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      const existing = entry.plan;
      if (!existing) {
        throw new Error("not in plan mode");
      }
      const next: SessionPlanState = {
        ...existing,
        status: "planning",
        updatedAt: now,
        ...(options.feedback ? { lastFeedback: options.feedback } : {}),
      };
      delete next.pendingQuestionId;
      updated = next;
      return { plan: next };
    },
    { fallbackEntry: options.fallbackEntry },
  );
  if (!patched || !updated) {
    throw new Error("session not found");
  }
  return clonePlan(updated);
}
