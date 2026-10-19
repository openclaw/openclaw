import { sortCronJobs } from "../../../../src/cron/service/list-page-sort.js";
import type { CronJob } from "../../api/types.ts";
import {
  loadCronJobsProjectionPage,
  type CronJobsPageOptions,
  type CronJobsProjection,
} from "./jobs.ts";
import { getCronJobPayload } from "./payload.ts";
import type { CronJobsState } from "./types.ts";

const fullCronJobsProjection: CronJobsProjection<CronJob> = {
  readRows: (rows) => rows.filter((job) => getCronJobPayload(job) !== null),
  applyRuntime: (state, index, { updatedAtMs, runtime }) => {
    const previous = state.cronJobs[index]!;
    state.cronJobs = sortCronJobs(
      state.cronJobs.with(index, {
        ...previous,
        updatedAtMs,
        state: { ...previous.state, ...runtime },
      }),
      state.cronJobsSortBy,
      state.cronJobsSortDir,
    );
    return true;
  },
};

export function loadCronJobsPage(state: CronJobsState, opts?: CronJobsPageOptions) {
  return loadCronJobsProjectionPage(state, fullCronJobsProjection, opts);
}
