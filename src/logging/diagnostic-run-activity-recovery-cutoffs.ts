import { hasPendingInternalDiagnosticOwnerEvent } from "../infra/diagnostic-events-state.js";
import { startedEventOwnerRefs } from "./diagnostic-run-activity-recovery.js";

function hasPendingOwnerEvent(
  ownerRef: string,
  throughSequence: number,
  excludingSequence?: number,
): boolean {
  return hasPendingInternalDiagnosticOwnerEvent(
    ownerRef,
    throughSequence,
    "run-or-session",
    excludingSequence,
  );
}

export function rememberRecoveredOwnerStartEventCutoffs(
  cutoffs: Map<string, number>,
  ownerRefs: Set<string>,
  recoveryStartedAfterSequence: number | undefined,
): void {
  if (recoveryStartedAfterSequence === undefined) {
    return;
  }
  for (const ownerRef of ownerRefs) {
    if (!hasPendingOwnerEvent(ownerRef, recoveryStartedAfterSequence)) {
      continue;
    }
    // Recovery can clear a session before the async diagnostic queue drains.
    // Remember the queue watermark so older start events cannot recreate stale activity.
    cutoffs.set(ownerRef, Math.max(recoveryStartedAfterSequence, cutoffs.get(ownerRef) ?? 0));
  }
}

export function pruneRecoveredOwnerStartEventCutoffs(cutoffs: Map<string, number>): void {
  for (const [ownerRef, cutoff] of cutoffs) {
    if (!hasPendingOwnerEvent(ownerRef, cutoff)) {
      cutoffs.delete(ownerRef);
    }
  }
}

export function shouldIgnoreRecoveredOwnerStartEvent(
  cutoffs: Map<string, number>,
  event: { runId?: string; sessionId?: string; seq?: number },
): boolean {
  if (event.seq === undefined) {
    return false;
  }
  let shouldIgnore = false;
  for (const ownerRef of startedEventOwnerRefs(event)) {
    const cutoff = cutoffs.get(ownerRef);
    if (cutoff !== undefined && event.seq <= cutoff) {
      shouldIgnore = true;
      if (!hasPendingOwnerEvent(ownerRef, cutoff, event.seq)) {
        cutoffs.delete(ownerRef);
      }
    }
  }
  return shouldIgnore;
}
