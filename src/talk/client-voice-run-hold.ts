// A consult can make several model attempts under one run id. Each attempt emits its own
// run.completed diagnostic, but the voice binding and confirmation grants belong to the
// whole consult, so completion cleanup waits until the consult releases its hold.

type ClientVoiceRunHold = { count: number; deferredCompletion?: () => void };

const holdsByRunId = new Map<string, ClientVoiceRunHold>();

/** Keep a run's voice binding alive across attempts; the returned release is idempotent. */
export function holdClientVoiceRunCompletion(runId: string): () => void {
  const hold = holdsByRunId.get(runId) ?? { count: 0 };
  hold.count += 1;
  holdsByRunId.set(runId, hold);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    hold.count -= 1;
    if (hold.count > 0) {
      return;
    }
    holdsByRunId.delete(runId);
    hold.deferredCompletion?.();
  };
}

/** Defer completion cleanup while the run is held. Returns false when nothing holds it. */
export function deferClientVoiceRunCompletion(runId: string, complete: () => void): boolean {
  const hold = holdsByRunId.get(runId);
  if (!hold) {
    return false;
  }
  hold.deferredCompletion = complete;
  return true;
}

export function resetClientVoiceRunHoldsForTest(): void {
  holdsByRunId.clear();
}
