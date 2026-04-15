import { setTimeout as delay } from "node:timers/promises";

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
  try {
    await delay(ms, undefined, { signal: abortSignal });
  } catch (error: unknown) {
    if (
      error != null &&
      typeof error === "object" &&
      (("name" in error && (error as { name?: unknown }).name === "AbortError") ||
        ("code" in error && (error as { code?: unknown }).code === "ABORT_ERR"))
    ) {
      throw new Error("aborted", { cause: abortSignal?.reason ?? new Error("aborted") });
    }
    throw error;
  }
}
