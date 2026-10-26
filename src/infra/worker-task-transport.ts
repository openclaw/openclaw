import type { MessagePort } from "node:worker_threads";
import type { DatabaseEngineSelection } from "./database-engine/context.js";

/** Private startup message shared by retained task hosts and their served workers. */
export const WORKER_TASK_PORT_MESSAGE = "openclaw.worker-task-port";

export type WorkerTaskContext = {
  collectWorkerMetrics?: boolean;
  databaseEngineSelection?: DatabaseEngineSelection;
  deletedAgentDatabaseFences: [string, string][];
  databaseAdmissionPort?: MessagePort;
  postgresPool?: import("./postgres-sync/pool.js").PostgresPoolEndpoints;
  databaseAdmissionDeadlineAtMs?: number;
};
