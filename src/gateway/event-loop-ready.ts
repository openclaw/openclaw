import { resolveSafeTimeoutDelayMs } from "../utils/timer-delay.js";

export type EventLoopReadyResult = {
  ready: boolean;
  elapsedMs: number;
  maxDriftMs: number;
  checks: number;
  aborted: boolean;
};

type EventLoopReadyOptions = {
  maxWaitMs?: number;
  intervalMs?: number;
  driftThresholdMs?: number;
  consecutiveReadyChecks?: number;
  signal?: AbortSignal;
};

// Aligned with DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS so the readiness wait and
// the outer handshake timer give up on roughly the same deadline. A 10 s wait
// is not long enough to ride out a slow CLI startup on lower-end x86_64 hosts
// with many gateway plugins installed (observed: ~30 s of event-loop blocking
// from module discovery / JIT compile during the first `openclaw devices list`
// after a cold launcher start). See handshake-timeouts.ts for the discussion.
const DEFAULT_MAX_WAIT_MS = 45_000;
const DEFAULT_INTERVAL_MS = 1;
const DEFAULT_DRIFT_THRESHOLD_MS = 200;
const DEFAULT_CONSECUTIVE_READY_CHECKS = 2;

function resolvePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined ? Math.max(1, Math.floor(value)) : fallback;
}

export async function waitForEventLoopReady(
  options: EventLoopReadyOptions = {},
): Promise<EventLoopReadyResult> {
  const maxWaitMs = resolveSafeTimeoutDelayMs(options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  const intervalMs = resolvePositiveInteger(options.intervalMs, DEFAULT_INTERVAL_MS);
  const driftThresholdMs = resolvePositiveInteger(
    options.driftThresholdMs,
    DEFAULT_DRIFT_THRESHOLD_MS,
  );
  const consecutiveReadyChecks = resolvePositiveInteger(
    options.consecutiveReadyChecks,
    DEFAULT_CONSECUTIVE_READY_CHECKS,
  );
  const signal = options.signal;

  const startedAt = Date.now();
  let readyChecks = 0;
  let checks = 0;
  let maxDriftMs = 0;

  return await new Promise<EventLoopReadyResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const finish = (ready: boolean, aborted = false) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer();
      signal?.removeEventListener("abort", onAbort);
      resolve({
        ready,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        maxDriftMs,
        checks,
        aborted,
      });
    };
    const onAbort = () => {
      finish(false, true);
    };
    if (signal?.aborted) {
      finish(false, true);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    const scheduleNext = () => {
      if (signal?.aborted) {
        finish(false, true);
        return;
      }
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      const remainingMs = maxWaitMs - elapsedMs;
      if (remainingMs <= 0) {
        finish(false);
        return;
      }
      const delayMs = Math.min(intervalMs, remainingMs);
      const scheduledAt = Date.now();
      timer = setTimeout(() => {
        timer = null;
        checks += 1;
        const driftMs = Math.max(0, Date.now() - scheduledAt - delayMs);
        maxDriftMs = Math.max(maxDriftMs, driftMs);
        if (driftMs > driftThresholdMs) {
          readyChecks = 0;
        } else {
          readyChecks += 1;
        }
        if (readyChecks >= consecutiveReadyChecks) {
          finish(true);
          return;
        }
        scheduleNext();
      }, delayMs);
    };

    scheduleNext();
  });
}
