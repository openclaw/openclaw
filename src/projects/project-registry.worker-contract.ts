import type { WorkerOperations } from "../state/worker-operation-registry.js";
import type { projectRegistryOperations } from "./project-registry.worker.js";

export type ProjectRegistryWorkerOperations = WorkerOperations<typeof projectRegistryOperations>;
