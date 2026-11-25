import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { monotonicDeadlineAfter, remainingMonotonicMs } from "../shared/monotonic-time.js";

/**
 * Run bounded work; dynamic labels identify the stage pending at the deadline.
 * `resetTimeout` re-arms the window, but never past `maxTotalMs` from the start.
 */
export async function runAbortableTimeout<T>(
  work: (signal: AbortSignal | undefined, resetTimeout: () => void) => Promise<T>,
  timeoutMs?: number,
  label?: string | (() => string),
  maxTotalMs?: number,
): Promise<T> {
  const resolved = timeoutMs === undefined ? undefined : resolveTimerTimeoutMs(timeoutMs, 1);
  if (!resolved) {
    return await work(undefined, () => {});
  }

  const abortCtrl = new AbortController();
  // Keep the deadline on the monotonic clock setTimeout arms on, so wall-clock jumps
  // can't inflate or collapse the remaining window resetTimeout re-reads across ticks.
  const deadline = maxTotalMs === undefined ? undefined : monotonicDeadlineAfter(maxTotalMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const resetTimeout = () => {
    const remainingMs = remainingMonotonicMs(deadline ?? Number.POSITIVE_INFINITY);
    // At the deadline the armed window is already due; re-arming would postpone it.
    if (settled || abortCtrl.signal.aborted || (timer && remainingMs <= 0)) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(
      () => {
        const operation = typeof label === "function" ? label() : (label ?? "request");
        abortCtrl.abort(new Error(`${operation} timed out`));
      },
      Math.max(0, Math.min(resolved, remainingMs)),
    );
    timer.unref?.();
  };
  resetTimeout();

  try {
    return await racePromiseWithAbortSignal(
      work(abortCtrl.signal, resetTimeout),
      abortCtrl.signal,
      (signal) => signal.reason,
    );
  } finally {
    settled = true;
    clearTimeout(timer);
  }
}
