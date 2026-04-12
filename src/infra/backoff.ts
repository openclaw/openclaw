export type BackoffPolicy = {
  initialMs: number;
  maxMs: number;
  factor: number;
  jitter: number;
};

export function computeBackoff(policy: BackoffPolicy, attempt: number) {
  const base = policy.initialMs * policy.factor ** Math.max(attempt - 1, 0);
  const jitter = base * policy.jitter * Math.random();
  return Math.min(policy.maxMs, Math.round(base + jitter));
}

export async function sleepWithAbort(ms: number, abortSignal?: AbortSignal) {
  if (ms <= 0) {
    return;
  }
  if (abortSignal?.aborted) {
    throw new Error("aborted", { cause: abortSignal.reason ?? new Error("aborted") });
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      settled = true;
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      timer = null;
      resolve();
    }, ms);

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
    }
  });
}
