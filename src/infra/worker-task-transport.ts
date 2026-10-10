import type { MessagePort } from "node:worker_threads";
import type { SqliteDatabaseAdmissions } from "./sqlite-database-admission.js";

/** Private startup message shared by retained task hosts and their served workers. */
export const WORKER_TASK_PORT_MESSAGE = "openclaw.worker-task-port";

export type WorkerTaskContext = {
  deletedAgentDatabaseFences: [string, string][];
  databaseAdmissions: SqliteDatabaseAdmissions;
  databaseAdmissionPort?: MessagePort;
};
