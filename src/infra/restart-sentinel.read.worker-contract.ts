import type { WorkerOperations } from "../state/worker-operation-registry.js";
import type { restartSentinelReadOperations } from "./restart-sentinel.read.worker.js";

export type RestartSentinelReadOperations = WorkerOperations<typeof restartSentinelReadOperations>;
