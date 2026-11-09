import type { WorkerOperations } from "../state/worker-operation-registry.js";
import type { restartSentinelOperations } from "./restart-sentinel.worker.js";

export type RestartSentinelWorkerOperations = WorkerOperations<typeof restartSentinelOperations>;
