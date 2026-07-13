// Shared execution admission for scheduled, manual, and on-exit cron runs.
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import type { CronServiceState } from "./state.js";

function resolveRunConcurrency(state: CronServiceState): number {
  return resolveIntegerOption(state.deps.cronConfig?.maxConcurrentRuns, 1, { min: 1 });
}

function dispatchWaiters(state: CronServiceState): void {
  const admission = state.runAdmission;
  if (state.stopped) {
    cancelCronRunAdmissionWaiters(state);
    return;
  }
  const maxConcurrentRuns = resolveRunConcurrency(state);
  while (admission.active < maxConcurrentRuns) {
    const waiter = admission.waiters.shift();
    if (!waiter) {
      return;
    }
    admission.active += 1;
    let released = false;
    waiter(() => {
      if (released) {
        return;
      }
      released = true;
      admission.active -= 1;
      dispatchWaiters(state);
    });
  }
}

async function acquireCronRunAdmission(state: CronServiceState): Promise<(() => void) | null> {
  const admission = state.runAdmission;
  if (state.stopped) {
    return null;
  }
  if (admission.waiters.length === 0 && admission.active < resolveRunConcurrency(state)) {
    admission.active += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      admission.active -= 1;
      dispatchWaiters(state);
    };
  }
  return await new Promise<(() => void) | null>((resolve) => {
    admission.waiters.push(resolve);
  });
}

/** Wake queued work on stop so each caller can release its durable reservation. */
export function cancelCronRunAdmissionWaiters(state: CronServiceState): void {
  const waiters = state.runAdmission.waiters.splice(0);
  for (const waiter of waiters) {
    waiter(null);
  }
}

/** Track a persisted marker only while it is waiting for shared admission. */
export function reserveQueuedCronRun(
  state: CronServiceState,
  jobId: string,
  reservationAt: number,
): void {
  state.queuedRunReservationAtByJobId.set(jobId, reservationAt);
}

export function releaseQueuedCronRun(
  state: CronServiceState,
  jobId: string,
  reservationAt?: number,
): void {
  if (
    reservationAt === undefined ||
    state.queuedRunReservationAtByJobId.get(jobId) === reservationAt
  ) {
    state.queuedRunReservationAtByJobId.delete(jobId);
  }
}

/** A matching process-local record means this durable marker is queued, not stuck. */
export function isQueuedCronRun(
  state: CronServiceState,
  jobId: string,
  runningAtMs: number,
): boolean {
  return state.queuedRunReservationAtByJobId.get(jobId) === runningAtMs;
}

/**
 * Apply one service-level cap to every cron execution source. Queue waiters
 * keep their job reservation, then recheck scheduler state before execution.
 */
export async function runWithCronAdmission<T>(
  state: CronServiceState,
  execute: () => Promise<T>,
): Promise<{ kind: "admitted"; value: T } | { kind: "stopped" }> {
  const release = await acquireCronRunAdmission(state);
  if (!release) {
    return { kind: "stopped" };
  }
  try {
    return { kind: "admitted", value: await execute() };
  } finally {
    release();
  }
}
