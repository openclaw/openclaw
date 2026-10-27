import type { WorkerOperations } from "../state/worker-operation-registry.js";
import type { execAuthorizationOperations } from "./exec-approvals-authorization.worker.js";

export type ExecAuthorizationWorkerOperations = WorkerOperations<
  typeof execAuthorizationOperations
>;
