/** Schedule computation error accounting and auto-disable policy. */
import { formatErrorMessageWithCode } from "../../infra/errors.js";
import type { CronJob } from "../types.js";
import { autoDisableCronJob } from "./auto-disable.js";
import type { CronServiceState, DeferredCronNotifications } from "./state.js";

const MAX_SCHEDULE_ERRORS = 3;

/** Records a schedule-computation failure and auto-disables after repeated errors. */
export function recordScheduleComputeError(params: {
  state: CronServiceState;
  job: CronJob;
  err: unknown;
  deferredNotifications?: DeferredCronNotifications;
}): boolean {
  const { state, job, err } = params;
  const errorCount = (job.state.scheduleErrorCount ?? 0) + 1;
  const errText = formatErrorMessageWithCode(err);

  job.state.scheduleErrorCount = errorCount;
  job.state.nextRunAtMs = undefined;
  job.state.lastError = `schedule error: ${errText}`;

  if (errorCount >= MAX_SCHEDULE_ERRORS) {
    autoDisableCronJob({
      state,
      job,
      reason: "schedule-errors",
      atMs: state.deps.nowMs(),
      consecutiveErrors: errorCount,
      deferredNotifications: params.deferredNotifications,
    });
    state.deps.log.error(
      { jobId: job.id, name: job.name, errorCount, err: errText },
      "cron: auto-disabled job after repeated schedule errors",
    );
  } else {
    state.deps.log.warn(
      { jobId: job.id, name: job.name, errorCount, err: errText },
      "cron: failed to compute next run for job (skipping)",
    );
  }

  return true;
}
