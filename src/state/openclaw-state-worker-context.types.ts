import type { SqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabaseReadAdmission } from "./openclaw-state-db-async-lifecycle.js";

export type OpenClawStateWorkerContext = SqliteWorkerStateContext & {
  admission: OpenClawStateDatabaseReadAdmission;
};
