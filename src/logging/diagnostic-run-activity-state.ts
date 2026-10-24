import type {
  CoreModelRequestOwnerGeneration,
  DiagnosticEmbeddedRunOwner,
} from "../infra/diagnostic-model-request-provenance.js";
import {
  type DiagnosticArgumentChurnActivity,
  mergeArgumentChurnActivity,
  recordDiagnosticActivityProgress,
} from "./diagnostic-argument-churn-activity.js";
import {
  type DiagnosticRepeatedRequestActivity,
  mergeRepeatedRequestActivity,
} from "./diagnostic-repeated-request-activity.js";
import {
  queueRecoveryCutoffCleanup,
  shouldIgnoreRecoveredOwnerStartEvent,
  type DiagnosticRecoveryActivity,
} from "./diagnostic-run-activity-recovery.js";

export type SessionActivity = DiagnosticArgumentChurnActivity &
  DiagnosticRepeatedRequestActivity &
  DiagnosticRecoveryActivity & {
    sessionId?: string;
    sessionKey?: string;
    lastProgressAt: number;
    lastProgressReason?: string;
  };

export type DiagnosticBackendActivity = {
  deadlineAtMs: number;
  assertCurrent: () => void;
};

export type DiagnosticOwnerRegistration = {
  activity: SessionActivity;
  owner: DiagnosticEmbeddedRunOwner;
  backendActivity?: DiagnosticBackendActivity;
  retryWait?: {
    deadlineAtMs: number;
    assertCurrent: () => void;
    close: () => void;
  };
};

export const activityByRef = new Map<string, SessionActivity>();
export const activityByRunId = new Map<string, SessionActivity>();
export const embeddedRunIndex = {
  remove(activity: SessionActivity, workKey: string): void {
    const embeddedRun = activity.activeEmbeddedRuns.get(workKey);
    if (!embeddedRun) {
      return;
    }
    activity.activeEmbeddedRuns.delete(workKey);
    const runIdStillActive = Array.from(activity.activeEmbeddedRuns.values()).some(
      (candidate) => candidate.runId === embeddedRun.runId,
    );
    if (!runIdStillActive && activityByRunId.get(embeddedRun.runId) === activity) {
      activityByRunId.delete(embeddedRun.runId);
    }
  },
  clear(activity: SessionActivity): void {
    // Every local owner is leaving; only retain indexes now owned by another activity.
    for (const { runId } of activity.activeEmbeddedRuns.values()) {
      if (activityByRunId.get(runId) === activity) {
        activityByRunId.delete(runId);
      }
    }
    activity.activeEmbeddedRuns.clear();
  },
};
export const activeDiagnosticOwners = new Map<
  CoreModelRequestOwnerGeneration,
  DiagnosticOwnerRegistration
>();
export function sessionRefs(params: { sessionId?: string; sessionKey?: string }): string[] {
  const refs: string[] = [];
  const sessionId = params.sessionId?.trim();
  const sessionKey = params.sessionKey?.trim();
  if (sessionId) {
    refs.push(`id:${sessionId}`);
  }
  if (sessionKey) {
    refs.push(`key:${sessionKey}`);
  }
  return refs;
}

const ACTIVITY_REF_TTL_MS = 30 * 60 * 1000;
const ACTIVITY_REF_PRUNE_INTERVAL_MS = 60 * 1000;
const ACTIVITY_REF_MAX_ACTIVITIES = 2000;

let lastActivityRefPruneAt = 0;
// Ref count right after the last scan; size pressure re-scans early only once new refs
// were added since, so a full index of live activities is not rebuilt on every lookup.
let activityRefCountAfterLastPrune = 0;

export function resetDiagnosticSessionActivityPruneState(): void {
  lastActivityRefPruneAt = 0;
  activityRefCountAfterLastPrune = 0;
}

/**
 * Tracks the most recently registered `id:` ref per activity so a session that keeps a
 * stable `sessionKey` but mints a fresh `sessionId` on every reset (a long-lived Gateway
 * cron/boot/subagent identity) does not accumulate an unbounded number of stale `id:`
 * aliases in `activityByRef` for one activity that stays "live" via continuous refresh and
 * therefore never ages out through the idle/TTL path.
 */
const currentIdRefByActivity = new WeakMap<SessionActivity, string>();

/**
 * True when nothing still points at live work for this activity: no embedded
 * run, tool, model call or core model call, no registered owner, and no run
 * that still tracks it. Only idle activities may be released.
 */
function isSessionActivityIdle(activity: SessionActivity): boolean {
  if (activity.activeEmbeddedRuns.size > 0) {
    return false;
  }
  if (activity.activeTools.size > 0) {
    return false;
  }
  if (activity.activeModelCalls.size > 0) {
    return false;
  }
  if (activity.activeCoreModelCalls.size > 0) {
    return false;
  }
  for (const registration of activeDiagnosticOwners.values()) {
    if (registration.activity === activity) {
      return false;
    }
  }
  for (const tracked of activityByRunId.values()) {
    if (tracked === activity) {
      return false;
    }
  }
  // A pending recovery cutoff means a queued start for this owner can still arrive and
  // needs to be compared against it; releasing the activity early would let that start
  // recreate a phantom activity with no cutoff, see diagnostic-run-activity-recovery.ts.
  if (activity.recoveredOwnerStartEventCutoffs.size > 0) {
    return false;
  }
  return true;
}

/** Groups the ref index by the activity it points at. */
function collectActivityRefsByActivity(): Map<SessionActivity, string[]> {
  const refsByActivity = new Map<SessionActivity, string[]>();
  for (const [ref, activity] of activityByRef) {
    const refs = refsByActivity.get(activity);
    if (refs) {
      refs.push(ref);
      continue;
    }
    refsByActivity.set(activity, [ref]);
  }
  return refsByActivity;
}

/**
 * Releases session activities that no longer describe live work.
 *
 * The ref index keeps one entry per session ref, so a long-lived Gateway that
 * mints a fresh session identity per run (cron runs, boot sessions, subagents)
 * would otherwise retain every one of them for the process lifetime. Idle
 * activities expire after a TTL and the retained set is capped, mirroring
 * `pruneDiagnosticSessionStates` for the sibling session-state index.
 *
 * Both refs of an activity (`id:` and `key:`) are released together; dropping
 * only one would leave the activity reachable through the other.
 */
function pruneDiagnosticSessionActivityRefs(now = Date.now()): void {
  const shouldPruneForSize =
    activityByRef.size > ACTIVITY_REF_MAX_ACTIVITIES * 2 &&
    activityByRef.size > activityRefCountAfterLastPrune;
  if (!shouldPruneForSize && now - lastActivityRefPruneAt < ACTIVITY_REF_PRUNE_INTERVAL_MS) {
    return;
  }
  lastActivityRefPruneAt = now;
  try {
    pruneDiagnosticSessionActivityRefsNow(now);
  } finally {
    activityRefCountAfterLastPrune = activityByRef.size;
  }
}

function pruneDiagnosticSessionActivityRefsNow(now: number): void {
  const refsByActivity = collectActivityRefsByActivity();
  const idle = [...refsByActivity.entries()].filter(([activity]) =>
    isSessionActivityIdle(activity),
  );

  const expired = new Set<SessionActivity>();
  for (const [activity, refs] of idle) {
    if (now - activity.lastProgressAt <= ACTIVITY_REF_TTL_MS) {
      continue;
    }
    expired.add(activity);
    for (const ref of refs) {
      activityByRef.delete(ref);
    }
  }

  const retained = refsByActivity.size - expired.size;
  if (retained <= ACTIVITY_REF_MAX_ACTIVITIES) {
    return;
  }
  // Insertions normally exceed the cap by one; equal ages keep Map order.
  const candidates = idle
    .filter(([activity]) => !expired.has(activity))
    .toSorted((left, right) => left[0].lastProgressAt - right[0].lastProgressAt);
  let overCap = retained - ACTIVITY_REF_MAX_ACTIVITIES;
  for (const [, refs] of candidates) {
    if (overCap <= 0) {
      break;
    }
    for (const ref of refs) {
      activityByRef.delete(ref);
    }
    overCap -= 1;
  }
}

function registerSessionActivityRefs(
  activity: SessionActivity,
  params: { sessionId?: string; sessionKey?: string; runId?: string; seq?: number },
): void {
  activity.sessionId ??= params.sessionId;
  activity.sessionKey ??= params.sessionKey;
  if (params.sessionId) {
    const nextIdRef = `id:${params.sessionId}`;
    const previousIdRef = currentIdRefByActivity.get(activity);
    // Keep the old alias while the activity still has live work or a pending recovery
    // cutoff: a queued ID-only event must still resolve to the fenced activity. The idle
    // prune releases the leftover alias together with the rest of the activity.
    if (
      previousIdRef &&
      previousIdRef !== nextIdRef &&
      activityByRef.get(previousIdRef) === activity &&
      isSessionActivityIdle(activity)
    ) {
      activityByRef.delete(previousIdRef);
    }
    currentIdRefByActivity.set(activity, nextIdRef);
  }
  for (const ref of sessionRefs(params)) {
    activityByRef.set(ref, activity);
  }
  if (params.runId && !shouldIgnoreRecoveredOwnerStartEvent(activity, params)) {
    activityByRunId.set(params.runId, activity);
  }
}

function replaceSessionActivityReferences(source: SessionActivity, target: SessionActivity): void {
  for (const index of [activityByRef, activityByRunId]) {
    for (const [key, activity] of index) {
      if (activity === source) {
        index.set(key, target);
      }
    }
  }
}

function mergeSessionActivity(target: SessionActivity, source: SessionActivity): void {
  target.sessionId ??= source.sessionId;
  target.sessionKey ??= source.sessionKey;
  for (const [key, embeddedRun] of source.activeEmbeddedRuns) {
    const existing = target.activeEmbeddedRuns.get(key);
    if (existing && existing.runId !== embeddedRun.runId) {
      embeddedRunIndex.remove(target, key);
    }
    target.activeEmbeddedRuns.set(key, embeddedRun);
  }
  for (const [key, tool] of source.activeTools) {
    target.activeTools.set(key, tool);
  }
  for (const [key, modelCall] of source.activeModelCalls) {
    target.activeModelCalls.set(key, modelCall);
  }
  for (const [generation, modelCalls] of source.activeCoreModelCalls) {
    target.activeCoreModelCalls.set(generation, modelCalls);
  }
  for (const registration of activeDiagnosticOwners.values()) {
    if (registration.activity === source) {
      registration.activity = target;
    }
  }
  for (const [ownerRef, cutoff] of source.recoveredOwnerStartEventCutoffs) {
    target.recoveredOwnerStartEventCutoffs.set(
      ownerRef,
      Math.max(cutoff, target.recoveredOwnerStartEventCutoffs.get(ownerRef) ?? 0),
    );
  }
  queueRecoveryCutoffCleanup(target);
  const sourceProgressIsNewer =
    source.lastProgressSequence !== undefined
      ? target.lastProgressSequence === undefined ||
        source.lastProgressSequence > target.lastProgressSequence
      : target.lastProgressSequence === undefined && source.lastProgressAt > target.lastProgressAt;
  if (sourceProgressIsNewer) {
    target.lastProgressAt = source.lastProgressAt;
    target.lastProgressReason = source.lastProgressReason;
    target.lastProgressSequence = source.lastProgressSequence;
  }
  mergeArgumentChurnActivity(target, source);
  mergeRepeatedRequestActivity(target, source);
  replaceSessionActivityReferences(source, target);
}

export function resolveSessionActivity(params: {
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  seq?: number;
  create?: boolean;
}): SessionActivity | undefined {
  // Release expired idle activities before the lookup so a stale entry cannot
  // answer for a session that is starting fresh work.
  pruneDiagnosticSessionActivityRefs();
  let activity = params.runId ? activityByRunId.get(params.runId) : undefined;
  const refs = sessionRefs(params);

  for (const ref of refs) {
    const byRef = activityByRef.get(ref);
    if (!byRef) {
      continue;
    }
    if (!activity) {
      activity = byRef;
    } else if (activity !== byRef) {
      mergeSessionActivity(activity, byRef);
    }
  }

  if (activity) {
    registerSessionActivityRefs(activity, params);
    return activity;
  }

  // Run-only signals can update existing activity, but cannot own session state.
  if (!params.create || refs.length === 0) {
    return undefined;
  }

  const created: SessionActivity = {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    activeEmbeddedRuns: new Map(),
    activeTools: new Map(),
    activeModelCalls: new Map(),
    activeCoreModelCalls: new Map(),
    recoveredOwnerStartEventCutoffs: new Map(),
    lastProgressAt: Date.now(),
  };
  registerSessionActivityRefs(created, params);
  return created;
}

export function touchSessionActivity(
  activity: SessionActivity,
  reason: string,
  now = Date.now(),
): void {
  activity.lastProgressAt = now;
  activity.lastProgressReason = reason;
  recordDiagnosticActivityProgress(activity);
}
