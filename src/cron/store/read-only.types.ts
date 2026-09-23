import type { SqliteWorkerReply } from "../../infra/sqlite-worker-contract.js";
import type { StateDatabaseCoordinatorRuntime } from "../../infra/state-database-coordinator.js";
import type { LoadedCronStore } from "./types.js";

export type CronReadOnlyRequest = {
  location: string;
  storeKey: string;
  stagingRoot?: string;
  coordinatorRuntime: StateDatabaseCoordinatorRuntime;
};
export type CronReadOnlyResult =
  | { ok: true; loaded: LoadedCronStore | undefined }
  | { ok: false; error: Extract<SqliteWorkerReply, { ok: false }>["error"] };
