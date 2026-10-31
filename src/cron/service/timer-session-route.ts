import { isPluginCommandCronJob } from "../plugin-command-schedule.js";
import type { CronStoredJob } from "../types.js";

// Plugin command schedules never take a session route: their reserved runner owns them, and these
// routes would prompt the model with the stored payload.

/** Whether an occurrence prepares its target session's pending automation notices. */
export function preparesCronSessionEvents(job: CronStoredJob): boolean {
  return (
    !isPluginCommandCronJob(job) &&
    (job.payload.kind === "agentTurn" || job.payload.kind === "systemEvent") &&
    (job.sessionTarget === "main" || job.sessionTarget.startsWith("session:"))
  );
}

/**
 * Whether an occurrence runs through the main-session route. `scheduledJob` is the stored job;
 * `effectiveJob` may carry appended trigger or stream text.
 */
export function runsCronMainSessionRoute(
  effectiveJob: CronStoredJob,
  scheduledJob: CronStoredJob,
): boolean {
  return (
    !isPluginCommandCronJob(scheduledJob) &&
    (effectiveJob.sessionTarget === "main" ||
      (effectiveJob.sessionTarget.startsWith("session:") &&
        effectiveJob.payload.kind === "agentTurn"))
  );
}
