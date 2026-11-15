import type { SessionControllerWatchdogAttempt } from "../sessions/session-controller.watchdog.js";
import { resolveCurrentDiagnosticRun } from "./diagnostic-embedded-run-index.js";

// A semantic-stall clock remains continuous across short model/tool handoffs,
// but later model progress wins once no churn observation refreshes this lease.
const ARGUMENT_CHURN_CONTINUITY_WINDOW_MS = 60_000;

export type DiagnosticArgumentChurnActivity = {
  argumentChurnStartedAt?: number;
  argumentChurnObservationAt?: number;
  argumentChurnObservationSequence?: number;
  argumentChurnRunId?: string;
  argumentChurnPolicyWaitRunId?: string;
  argumentChurnPolicyWaitTokens?: Set<symbol>;
  lastProgressSequence?: number;
};

// Wall-clock timestamps measure staleness; this process-local order breaks
// same-millisecond ties between progress, churn observations, and merged refs.
let diagnosticActivitySequence = 0;

export function recordDiagnosticActivityProgress(activity: DiagnosticArgumentChurnActivity): void {
  activity.lastProgressSequence = ++diagnosticActivitySequence;
}

export type DiagnosticArgumentChurnObservationParams = {
  watchdogAttempt?: SessionControllerWatchdogAttempt;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  active?: boolean;
  existingOnly?: boolean;
  policyWait?: "enter" | "exit";
  policyWaitToken?: symbol;
  now?: number;
};

function hasArgumentChurnContinuityExpired(
  activity: DiagnosticArgumentChurnActivity,
  now: number,
): boolean {
  const observationAt = activity.argumentChurnObservationAt;
  const observationSequence = activity.argumentChurnObservationSequence;
  const lastProgressSequence = activity.lastProgressSequence;
  const progressFollowedObservation =
    observationSequence !== undefined &&
    lastProgressSequence !== undefined &&
    lastProgressSequence > observationSequence;
  return (
    observationAt !== undefined &&
    progressFollowedObservation &&
    now - observationAt >= ARGUMENT_CHURN_CONTINUITY_WINDOW_MS
  );
}

export function resolveArgumentChurnProgress(
  activity: DiagnosticArgumentChurnActivity & {
    lastProgressAt: number;
    lastProgressReason?: string;
  },
  currentOwnerRunId: string | undefined,
  now: number,
): { lastProgressAt: number; lastProgressReason?: string } {
  if (
    currentOwnerRunId !== undefined &&
    activity.argumentChurnPolicyWaitRunId === currentOwnerRunId &&
    (activity.argumentChurnPolicyWaitTokens?.size ?? 0) > 0
  ) {
    return { lastProgressAt: now, lastProgressReason: "tool_policy:pending" };
  }
  const startedAt = activity.argumentChurnStartedAt;
  const belongsToOwner =
    startedAt !== undefined && currentOwnerRunId === activity.argumentChurnRunId;
  if (!belongsToOwner || hasArgumentChurnContinuityExpired(activity, now)) {
    return {
      lastProgressAt: activity.lastProgressAt,
      lastProgressReason: activity.lastProgressReason,
    };
  }
  return {
    lastProgressAt: startedAt,
    lastProgressReason: "tool_loop:argument_churn",
  };
}

export function clearArgumentChurnPolicyWaits(
  activity: DiagnosticArgumentChurnActivity,
  params: { runId?: string } = {},
): boolean {
  if (params.runId !== undefined && activity.argumentChurnPolicyWaitRunId !== params.runId) {
    return false;
  }
  const cleared = (activity.argumentChurnPolicyWaitTokens?.size ?? 0) > 0;
  activity.argumentChurnPolicyWaitRunId = undefined;
  activity.argumentChurnPolicyWaitTokens = undefined;
  return cleared;
}

export function applyArgumentChurnObservation<T extends { runId: string; sequence: number }>(
  activity: DiagnosticArgumentChurnActivity,
  owners: Iterable<T>,
  params: DiagnosticArgumentChurnObservationParams,
): void {
  const now = params.now ?? Date.now();
  const runId = params.runId?.trim() || undefined;
  const currentOwnerRunId = resolveCurrentDiagnosticRun(owners)?.runId;
  if (currentOwnerRunId !== undefined && currentOwnerRunId !== runId) {
    return;
  }
  if (params.policyWait) {
    if (params.policyWaitToken) {
      if (params.policyWait === "enter") {
        if (activity.argumentChurnPolicyWaitRunId !== runId) {
          activity.argumentChurnPolicyWaitRunId = runId;
          activity.argumentChurnPolicyWaitTokens = new Set();
        }
        activity.argumentChurnPolicyWaitTokens?.add(params.policyWaitToken);
        return;
      }
      if (activity.argumentChurnPolicyWaitRunId !== runId) {
        return;
      }
      activity.argumentChurnPolicyWaitTokens?.delete(params.policyWaitToken);
      if (activity.argumentChurnPolicyWaitTokens?.size === 0) {
        activity.argumentChurnPolicyWaitRunId = undefined;
        activity.argumentChurnPolicyWaitTokens = undefined;
      }
    }
    return;
  }
  if (
    params.existingOnly &&
    (activity.argumentChurnStartedAt === undefined || activity.argumentChurnRunId !== runId)
  ) {
    return;
  }
  if (params.active !== true) {
    if (activity.argumentChurnRunId === runId) {
      clearArgumentChurnActivity(activity, { now, runId });
    }
    return;
  }
  const continuityExpired = hasArgumentChurnContinuityExpired(activity, now);
  if (
    activity.argumentChurnStartedAt === undefined ||
    activity.argumentChurnRunId !== runId ||
    continuityExpired
  ) {
    activity.argumentChurnStartedAt = now;
    activity.argumentChurnRunId = runId;
  }
  activity.argumentChurnObservationAt = now;
  activity.argumentChurnObservationSequence = ++diagnosticActivitySequence;
}

export function mergeArgumentChurnActivity(
  target: DiagnosticArgumentChurnActivity,
  source: DiagnosticArgumentChurnActivity,
): void {
  const sourceObservationSequence = source.argumentChurnObservationSequence;
  const targetObservationSequence = target.argumentChurnObservationSequence;
  // Observations and clears always record their process-local sequence together.
  const sourceIsNewer =
    sourceObservationSequence !== undefined &&
    sourceObservationSequence > (targetObservationSequence ?? 0);

  if (
    source.argumentChurnStartedAt !== undefined &&
    source.argumentChurnRunId === target.argumentChurnRunId &&
    target.argumentChurnStartedAt !== undefined
  ) {
    target.argumentChurnStartedAt = Math.min(
      target.argumentChurnStartedAt,
      source.argumentChurnStartedAt,
    );
    if (sourceIsNewer) {
      target.argumentChurnObservationAt = source.argumentChurnObservationAt;
      target.argumentChurnObservationSequence = sourceObservationSequence;
    }
  } else if (sourceIsNewer) {
    target.argumentChurnStartedAt = source.argumentChurnStartedAt;
    target.argumentChurnObservationAt = source.argumentChurnObservationAt;
    target.argumentChurnObservationSequence = sourceObservationSequence;
    target.argumentChurnRunId = source.argumentChurnRunId;
  }

  if ((source.argumentChurnPolicyWaitTokens?.size ?? 0) === 0) {
    return;
  }
  if (target.argumentChurnPolicyWaitRunId !== source.argumentChurnPolicyWaitRunId) {
    if ((target.argumentChurnPolicyWaitTokens?.size ?? 0) === 0) {
      target.argumentChurnPolicyWaitRunId = source.argumentChurnPolicyWaitRunId;
      target.argumentChurnPolicyWaitTokens = new Set(source.argumentChurnPolicyWaitTokens);
    }
    return;
  }
  target.argumentChurnPolicyWaitTokens ??= new Set();
  for (const token of source.argumentChurnPolicyWaitTokens ?? []) {
    target.argumentChurnPolicyWaitTokens.add(token);
  }
}

export function clearArgumentChurnActivity(
  activity: DiagnosticArgumentChurnActivity,
  params: { now?: number; runId?: string } = {},
): boolean {
  const cleared = activity.argumentChurnStartedAt !== undefined;
  activity.argumentChurnStartedAt = undefined;
  activity.argumentChurnObservationAt = params.now ?? Date.now();
  activity.argumentChurnObservationSequence = ++diagnosticActivitySequence;
  activity.argumentChurnRunId = params.runId;
  return cleared;
}
