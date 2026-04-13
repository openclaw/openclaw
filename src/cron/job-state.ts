import type { CronJobState } from "./types.js";

type CronJobStateContainer = {
  state?: unknown;
};

export function ensureCronJobState(job: CronJobStateContainer): CronJobState {
  const state = job.state;
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    const emptyState: CronJobState = {};
    job.state = emptyState;
    return emptyState;
  }
  return state as CronJobState;
}
