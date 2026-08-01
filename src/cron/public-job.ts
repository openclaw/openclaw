import type { CronJob } from "./types.js";

/** Returns the human-readable label for operator-facing cron output. */
export function resolveCronJobDisplayName(
  job: Pick<CronJob, "id" | "name" | "displayName">,
): string {
  return job.displayName ?? job.name ?? job.id;
}

/** Remove scheduler-only state before a cron job crosses a public API boundary. */
export function toPublicCronJob(job: CronJob): CronJob {
  const state = { ...job.state };
  delete state.queuedAtMs;
  delete state.startupCatchupAtMs;
  delete state.pacedNextRunAtMs;
  delete state.forcePreservedNextRunAtMs;
  return { ...job, state };
}
