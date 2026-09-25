import type { SqliteWorkerReply } from "../../infra/sqlite-worker-contract.js";
import type { StateDatabaseCoordinatorRuntime } from "../../infra/state-database-coordinator.js";
import type { PluginDoctorCronJob } from "../../plugins/doctor-contract-module.js";
import type { LoadedCronStore } from "./types.js";

export type CronReadOnlyRequest = {
  location: string;
  /** Omitted only for Doctor's all-partition raw inventory. */
  storeKey?: string;
  stagingRoot?: string;
  coordinatorRuntime: StateDatabaseCoordinatorRuntime;
};
export type CronReadOnlyResult =
  | { ok: true; loaded?: LoadedCronStore; inventory?: PluginDoctorCronJob[] }
  | { ok: false; error: Extract<SqliteWorkerReply, { ok: false }>["error"] };
