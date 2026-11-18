import type { WorkerOperations } from "../../state/worker-operation-registry.js";
import type { workerEnvironmentOperations } from "./store.worker.js";

export type WorkerEnvironmentWorkerOperations = WorkerOperations<
  typeof workerEnvironmentOperations
>;
