/**
 * A deadline captured on the process-monotonic clock, with a closure that
 * reports the remaining budget without consulting wall-clock time.
 *
 * Process-group retirement waits must be immune to wall-clock (NTP) jumps:
 * a forward jump must not prematurely escalate cleanup, and a backward jump
 * must not extend it. Every remaining-budget read therefore uses the monotonic
 * clock (performance.now), never Date.now.
 */
export function monotonicDeadline(timeoutMs: number): {
  deadline: number;
  remaining: () => number;
} {
  const deadline = performance.now() + timeoutMs;
  return { deadline, remaining: () => Math.max(0, deadline - performance.now()) };
}
