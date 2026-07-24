import { hasPendingInternalDiagnosticOwnerEvent } from "../infra/diagnostic-events.js";

type RecoveryOwnerParams = {
  sessionId?: string;
  activeSessionId?: string;
};

type OwnedActivityMarker = {
  runId?: string;
  sessionId?: string;
};

type SequencedActivityMarker = {
  sequence?: number;
};

export function recoveryOwnerRefs(params: RecoveryOwnerParams): Set<string> {
  const refs = [params.activeSessionId?.trim(), params.sessionId?.trim()].filter(
    (ref): ref is string => Boolean(ref),
  );
  return new Set(refs);
}

export function startedEventOwnerRefs(event: OwnedActivityMarker): string[] {
  return [event.runId?.trim(), event.sessionId?.trim()].filter((ref): ref is string =>
    Boolean(ref),
  );
}

export function activityMarkerBelongsToOwner(
  marker: OwnedActivityMarker,
  ownerRefs: Set<string>,
): boolean {
  return (
    (marker.runId !== undefined && ownerRefs.has(marker.runId)) ||
    (marker.sessionId !== undefined && ownerRefs.has(marker.sessionId))
  );
}

export function activityMarkerStartedAfter(
  marker: SequencedActivityMarker,
  sequence: number | undefined,
): boolean {
  return sequence !== undefined && marker.sequence !== undefined && marker.sequence > sequence;
}

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

export type DiagnosticActiveRun = {
  sessionId?: string;
  sequence?: number;
};

type DiagnosticActiveRunEvent = {
  runId?: string;
  sessionId?: string;
  seq?: number;
};

export function registerDiagnosticActiveRun(
  activeRuns: Map<string, DiagnosticActiveRun>,
  event: DiagnosticActiveRunEvent,
  fallbackSessionId?: string,
): string | undefined {
  if (!event.runId) {
    return undefined;
  }
  const existing = activeRuns.get(event.runId);
  activeRuns.set(event.runId, {
    sessionId: event.sessionId ?? existing?.sessionId ?? fallbackSessionId,
    sequence:
      event.seq === undefined
        ? existing?.sequence
        : Math.max(event.seq, existing?.sequence ?? event.seq),
  });
  return event.runId;
}

export function mergeDiagnosticActiveRuns(
  target: Map<string, DiagnosticActiveRun>,
  source: Map<string, DiagnosticActiveRun>,
): void {
  for (const [runId, activeRun] of source) {
    registerDiagnosticActiveRun(
      target,
      { runId, sessionId: activeRun.sessionId, seq: activeRun.sequence },
      activeRun.sessionId,
    );
  }
}

function activeRunStartedAfter(activeRun: DiagnosticActiveRun, sequence: number | undefined) {
  return (
    sequence !== undefined && activeRun.sequence !== undefined && activeRun.sequence > sequence
  );
}

export function deleteRecoveredDiagnosticActiveRuns(
  activeRuns: Map<string, DiagnosticActiveRun>,
  ownerRefs: Set<string>,
  recoveryStartedAfterSequence: number | undefined,
  onDelete: (runId: string) => void,
): void {
  for (const [runId, activeRun] of activeRuns) {
    const belongsToOwner =
      ownerRefs.has(runId) ||
      (activeRun.sessionId !== undefined && ownerRefs.has(activeRun.sessionId));
    if (belongsToOwner && !activeRunStartedAfter(activeRun, recoveryStartedAfterSequence)) {
      activeRuns.delete(runId);
      onDelete(runId);
    }
  }
}

export function deleteDiagnosticActiveRunsStartedBefore(
  activeRuns: Map<string, DiagnosticActiveRun>,
  sequence: number | undefined,
  onDelete: (runId: string) => void,
): void {
  for (const [runId, activeRun] of activeRuns) {
    if (!activeRunStartedAfter(activeRun, sequence)) {
      activeRuns.delete(runId);
      onDelete(runId);
    }
  }
}
