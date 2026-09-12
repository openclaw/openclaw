import { setTimeout as sleep } from "node:timers/promises";

/** Retry only acquisition, keeping the deadline independent of wall-clock changes. */
export async function acquireWithWait<T>(params: {
  acquire: () => T;
  shouldRetry: (error: unknown) => boolean;
  deadlineMs: number;
  pollIntervalMs: number;
  maxPollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<T> {
  const now = params.now ?? performance.now.bind(performance);
  let delayMs = params.pollIntervalMs;
  for (;;) {
    try {
      return params.acquire();
    } catch (error) {
      if (!params.shouldRetry(error)) {
        throw error;
      }
      const remainingMs = params.deadlineMs - now();
      if (remainingMs <= 0) {
        throw error;
      }
      await (params.sleep ?? sleep)(Math.min(delayMs, remainingMs));
      delayMs = Math.min(delayMs * 2, params.maxPollIntervalMs ?? params.pollIntervalMs);
    }
  }
}
