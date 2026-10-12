import type { WorkerOperations } from "../state/worker-operation-registry.js";
import type { configSnapshotOperations } from "./config-journal-snapshot.worker.js";

export type ConfigSnapshotWorkerOperations = WorkerOperations<typeof configSnapshotOperations>;
