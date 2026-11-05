import { CRON_HOST_EXECUTION_DISABLED_MESSAGE } from "../cron/service/state.js";
import type { CronJobState, CronStoredJob } from "../cron/types.js";
import type { CronStreamJob } from "./cron-stream-output.js";
import type { CronStreamStopReason } from "./cron-stream-owner-types.js";

const COUNTER_MAX = 2_147_483_647;

/** Requires the persisted logical identity rather than inventing one during recovery. */
export function sourceIdentityFor(job: CronStreamJob): string {
  const identity = job.state.streamSourceIdentity?.trim();
  if (!identity) {
    throw new Error(`stream job ${job.id} is missing its source identity`);
  }
  return identity;
}

/** Names the existing supervisor scope for one stream job. */
export const scopeKey = (jobId: string): string => `cron-stream:${jobId}`;

/** Selects lifecycle stops that also retire the logical source identity. */
export function stopRequiresSourceRetirement(reason: CronStreamStopReason): boolean {
  return (
    reason === "removed" ||
    reason === "shutdown" ||
    reason === "trust-disabled" ||
    reason === "cron-disabled"
  );
}

/** Keeps durable stream counters within the existing integer budget. */
export function boundedCounter(value: number | undefined, increment = 0): number {
  return Math.min(COUNTER_MAX, Math.max(0, Math.floor(value ?? 0)) + increment);
}

/** Distinguishes stream schedules for the existing process owner. */
export function isCronStreamJob(job: CronStoredJob): job is CronStreamJob {
  return job.schedule.kind === "stream";
}

const DISABLED_STREAM_ERRORS: Partial<Record<CronStreamStopReason, string>> = {
  "trust-disabled":
    "stream sources are disabled because the operator set cron.triggers.enabled: false; remove it or set it to true",
  "cron-disabled": "cron is disabled",
  "host-execution-disabled": CRON_HOST_EXECUTION_DISABLED_MESSAGE,
};

/** Project the completed stop while retaining terminal restart-exhaustion evidence. */
export function stoppedSourceState(
  reason: CronStreamStopReason,
  restartExhausted: boolean,
  restartFailure?: string,
): Partial<CronJobState> {
  const disabledError = DISABLED_STREAM_ERRORS[reason];
  const stopped: Partial<CronJobState> = disabledError
    ? { streamStatus: "disabled", streamError: disabledError }
    : (reason === "restart-exhausted" || reason === "shutdown") && restartExhausted
      ? { streamStatus: "error", streamError: restartFailure, streamRestartExhausted: true }
      : { streamStatus: "stopped", streamError: undefined };
  return { ...stopped, ...(!restartExhausted ? { streamRestartExhausted: undefined } : {}) };
}
