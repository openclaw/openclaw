/** Process-local milliseconds: never persist or exchange these readings as epochs. */
export function monotonicNow(): number {
  return performance.now();
}

export function monotonicDeadlineAfter(timeoutMs: number): number {
  return monotonicNow() + timeoutMs;
}

/** Signed remaining budget; callers retain their expiration and rounding policy. */
export function remainingMonotonicMs(deadline: number): number {
  return deadline - monotonicNow();
}
