import type { CronJob } from "../../api/types.ts";
import { readCronInventory } from "./inventory.ts";
import {
  loadCronJobsProjectionPage,
  type CronJobsPageOptions,
  type CronJobsProjection,
} from "./jobs.ts";
import type { CronJobsState } from "./types.ts";

const fullCronJobsProjection: CronJobsProjection<CronJob> = {
  read: (client, params, options) => readCronInventory(client, params, options),
};

export function loadCronJobsPage(state: CronJobsState, opts?: CronJobsPageOptions) {
  return loadCronJobsProjectionPage(state, fullCronJobsProjection, opts);
}
