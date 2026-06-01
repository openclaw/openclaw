import { clampPositiveTimerTimeoutMs } from "../shared/number-coercion.js";

/** Exponential backoff policy with additive positive jitter. */
export type BackoffPolicy = {
  initialMs: number;
  maxMs: number;
  factor: number;
  jitter: number;
};

/** Computes the delay for an attempt, treating attempt <= 1 as the first step. */
export function computeBackoff(policy: BackoffPolicy, attempt: number) {
  const base = policy.initialMs * policy.factor ** Math.max(attempt - 1, 0);
  const jitter = base * policy.jitter * Math.random();
  return Math.min(policy.maxMs, Math.round(base + jitter));
}

/** Sleeps for a Node-safe positive delay and rejects with a stable abort error. */
export async function sleepWithAbort(ms: number, abortSignal?: AbortSignal) {
  const delayMs = clampPositiveTimerTimeoutMs(ms);
  if (delayMs === undefined) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      reject(new Error("aborted", { cause: abortSignal?.reason ?? new Error("aborted") }));
    };

    if (abortSignal) {
      abortSignal.addEventListener("abort", onAbort, { once: true });
      // Abort can race with listener registration in tests and custom signals;
      // check immediately so the timer is never armed for an already-aborted signal.
      if (abortSignal.aborted) {
        onAbort();
        return;
      }
    }

    timer = setTimeout(() => {
      settled = true;
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      timer = null;
      resolve();
    }, delayMs);

    if (abortSignal) {
      // Native AbortSignal should not flip here after registration, but custom
      // signal implementations can; repeat the guard after the timer is armed.
      if (abortSignal.aborted) {
        onAbort();
      }
    }
  });
}
