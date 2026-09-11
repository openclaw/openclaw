import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";

export const ABSOLUTE_DEADLINE_EXPIRED = Symbol("absolute deadline expired");

/** Rechecks the selected clock because timers can run early or overflow long delays. */
export function scheduleAbsoluteDeadline(
  deadlineAtMs: number,
  onExpired: () => void,
  now: () => number = () => Date.now(),
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const checkDeadline = () => {
    const remainingMs = Math.max(0, deadlineAtMs - now());
    if (remainingMs === 0) {
      onExpired();
      return;
    }
    timer = setTimeout(checkDeadline, Math.min(remainingMs, MAX_TIMER_TIMEOUT_MS));
  };
  checkDeadline();
  return () => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  };
}

/** Bounds one operation by an absolute deadline in the selected clock. */
export async function awaitWithinDeadline<T>(
  operation: () => Promise<T>,
  deadlineAtMs: number | undefined,
  now: () => number = () => Date.now(),
): Promise<T | typeof ABSOLUTE_DEADLINE_EXPIRED> {
  if (deadlineAtMs === undefined) {
    return await operation();
  }
  if (Math.max(0, deadlineAtMs - now()) === 0) {
    return ABSOLUTE_DEADLINE_EXPIRED;
  }

  let cancelDeadline: (() => void) | undefined;
  try {
    // Arm the timer before caller code can synchronously consume the budget;
    // timer callbacks alone cannot establish an absolute deadline.
    const deadline = new Promise<typeof ABSOLUTE_DEADLINE_EXPIRED>((resolve) => {
      cancelDeadline = scheduleAbsoluteDeadline(
        deadlineAtMs,
        () => resolve(ABSOLUTE_DEADLINE_EXPIRED),
        now,
      );
    });
    return await Promise.race([
      deadline,
      operation().then((result) => (now() >= deadlineAtMs ? ABSOLUTE_DEADLINE_EXPIRED : result)),
    ]);
  } finally {
    cancelDeadline?.();
  }
}
