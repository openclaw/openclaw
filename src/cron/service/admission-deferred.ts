import type { CronJob, CronJobExecutionResult } from "../types.js";

/** Effects or trigger evaluation consume an occurrence even if a later admission defers. */
export function hasUnstartedCronAdmission(result: CronJobExecutionResult): boolean {
  return (
    result.status === "skipped" &&
    result.admissionDeferred === true &&
    result.executionStarted === false &&
    result.delivered !== true &&
    result.deliveryAttempted !== true &&
    result.triggerEval === undefined
  );
}

/** Timed slots and exact stream buffers retain their own scheduling responsibility. */
export function isDeferredCronAdmission(
  job: Pick<CronJob, "schedule">,
  result: CronJobExecutionResult,
): boolean {
  return (
    hasUnstartedCronAdmission(result) &&
    (job.schedule.kind === "at" ||
      job.schedule.kind === "every" ||
      job.schedule.kind === "cron" ||
      (job.schedule.kind === "stream" && result.admissionDeferredReason === "busy"))
  );
}
