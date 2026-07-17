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
