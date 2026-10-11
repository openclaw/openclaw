import type { WorkerOperations } from "../../state/worker-operation-registry.js";
import type { workerInferenceOperations } from "./inference-store.worker.js";

export type WorkerInferenceStoreOperations = WorkerOperations<typeof workerInferenceOperations>;
