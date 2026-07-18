const DIAGNOSTIC_EVENTS_STATE_KEY = Symbol.for("openclaw.diagnosticEvents.state.v1");

type DiagnosticEventsPendingRunState = {
  pendingAsyncRunEventSequences?: Map<string, Set<number>>;
  pendingAsyncSessionEventSequences?: Map<string, Set<number>>;
};

function hasPendingSequence(sequences: Set<number> | undefined, throughSequence: number): boolean {
  if (!sequences) {
    return false;
  }
  for (const sequence of sequences) {
    if (sequence <= throughSequence) {
      return true;
    }
  }
  return false;
}

function hasOtherPendingSequence(
  sequences: Set<number> | undefined,
  throughSequence: number,
  currentSequence: number,
): boolean {
  if (!sequences) {
    return false;
  }
  for (const sequence of sequences) {
    if (sequence !== currentSequence && sequence <= throughSequence) {
      return true;
    }
  }
  return false;
}

export function hasPendingInternalDiagnosticRunEvent(
  runId: string,
  throughSequence: number,
): boolean {
  const state = (globalThis as Record<PropertyKey, unknown>)[DIAGNOSTIC_EVENTS_STATE_KEY] as
    | DiagnosticEventsPendingRunState
    | undefined;
  return hasPendingSequence(state?.pendingAsyncRunEventSequences?.get(runId), throughSequence);
}

export function hasPendingInternalDiagnosticOwnerEvent(
  ownerRef: string,
  throughSequence: number,
): boolean {
  const state = (globalThis as Record<PropertyKey, unknown>)[DIAGNOSTIC_EVENTS_STATE_KEY] as
    | DiagnosticEventsPendingRunState
    | undefined;
  return (
    hasPendingSequence(state?.pendingAsyncRunEventSequences?.get(ownerRef), throughSequence) ||
    hasPendingSequence(state?.pendingAsyncSessionEventSequences?.get(ownerRef), throughSequence)
  );
}

export function hasOtherPendingInternalDiagnosticOwnerEvent(
  ownerRef: string,
  throughSequence: number,
  currentSequence: number,
): boolean {
  const state = (globalThis as Record<PropertyKey, unknown>)[DIAGNOSTIC_EVENTS_STATE_KEY] as
    | DiagnosticEventsPendingRunState
    | undefined;
  return (
    hasOtherPendingSequence(
      state?.pendingAsyncRunEventSequences?.get(ownerRef),
      throughSequence,
      currentSequence,
    ) ||
    hasOtherPendingSequence(
      state?.pendingAsyncSessionEventSequences?.get(ownerRef),
      throughSequence,
      currentSequence,
    )
  );
}
