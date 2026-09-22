import type { SqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type {
  OpenClawDatabaseMaintenanceScope,
  OpenClawStateDatabaseReadAdmission,
} from "./openclaw-state-db-async-lifecycle.js";

export type OpenClawStateWorkerContext = SqliteWorkerStateContext & {
  admission: OpenClawStateDatabaseReadAdmission;
  /** Host-only ownership; worker messages carry only a per-job coordinator delegate. */
  maintenanceScope?: OpenClawDatabaseMaintenanceScope;
};
