/**
 * Backend-reported background work for stuck-session diagnostics.
 *
 * A CLI backend that hands a turn to a subagent or workflow keeps its own
 * no-output deadline open while that child runs, because the parent emits no
 * stream chunks meanwhile. The diagnostic watchdog sees only the silence, so
 * without this signal the two watchdogs disagree and the less-informed one
 * aborts a healthy run.
 */

type DiagnosticSessionRef = {
  sessionId?: string;
  sessionKey?: string;
};

const outstandingBackgroundWorkRefs = new Set<string>();

function backgroundWorkRefs(params: DiagnosticSessionRef): string[] {
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

/** Record whether a backend still owns background work for this session. */
export function recordDiagnosticOutstandingBackgroundWork(
  params: DiagnosticSessionRef & { outstanding: boolean },
): void {
  for (const ref of backgroundWorkRefs(params)) {
    if (params.outstanding) {
      outstandingBackgroundWorkRefs.add(ref);
    } else {
      outstandingBackgroundWorkRefs.delete(ref);
    }
  }
}

/** True when a backend reported background work still holding this session. */
export function hasDiagnosticOutstandingBackgroundWork(params: DiagnosticSessionRef): boolean {
  return backgroundWorkRefs(params).some((ref) => outstandingBackgroundWorkRefs.has(ref));
}

export function resetDiagnosticBackgroundWorkForTest(): void {
  outstandingBackgroundWorkRefs.clear();
}
