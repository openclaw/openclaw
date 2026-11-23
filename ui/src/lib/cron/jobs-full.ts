import { sortCronJobs } from "../../../../src/cron/service/list-page-sort.js";
import type { CronJob } from "../../api/types.ts";
import { readCronInventory } from "./inventory.ts";
import {
  loadCronJobsProjectionPage,
  type CronJobsPageOptions,
  type CronJobsProjection,
} from "./jobs.ts";
import { applyFullCronRuntime } from "./runtime-projection.ts";
import type { CronJobsState } from "./types.ts";

const fullCronJobsProjection: CronJobsProjection<CronJob> = {
  read: (client, params, options) => readCronInventory(client, params, options),
  applyRuntime: (state, index, event) => {
    const previous = state.cronJobs[index]!;
    state.cronJobs = sortCronJobs(
      state.cronJobs.with(index, applyFullCronRuntime(previous, event)),
      state.cronJobsSortBy,
      state.cronJobsSortDir,
    );
    return true;
  },
};

export function loadCronJobsPage(state: CronJobsState, opts?: CronJobsPageOptions) {
  return loadCronJobsProjectionPage(state, fullCronJobsProjection, opts);
}
