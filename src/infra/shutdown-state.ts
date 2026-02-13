let shutdownStartedAtMs: number | null = null;
let shutdownReason: string | null = null;

export function markShutdownInProgress(reason?: string) {
  if (shutdownStartedAtMs != null) {
    return;
  }
  shutdownStartedAtMs = Date.now();
  shutdownReason = reason?.trim() || null;
}

export function isShutdownInProgress() {
  return shutdownStartedAtMs != null;
}

export function getShutdownState() {
  return {
    startedAtMs: shutdownStartedAtMs,
    reason: shutdownReason,
  };
}

export function clearShutdownInProgress() {
  shutdownStartedAtMs = null;
  shutdownReason = null;
}

export function resetShutdownStateForTest() {
  clearShutdownInProgress();
}
