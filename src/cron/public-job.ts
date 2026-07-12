/** Public cron job projections shared by Gateway reads, events, and hooks. */
import type { CronEvent } from "./service.js";
import type { CronJob } from "./types.js";

export function publicCronJobState(job: Pick<CronJob, "state">): CronJob["state"] {
  const { pendingCatchupDeferral: _pendingCatchupDeferral, ...state } = job.state;
  return state;
}

export function publicCronJobSnapshot(job: CronJob): CronJob {
  return {
    ...job,
    state: publicCronJobState(job),
  };
}

export function publicCronEventSnapshot(evt: CronEvent): CronEvent {
  if (!evt.job) {
    return evt;
  }
  return {
    ...evt,
    job: publicCronJobSnapshot(evt.job),
  };
}
