import type { WorkerOperations } from "../state/worker-operation-registry.js";
import type { webPushOperations } from "./push-web-store.worker.js";

export type WebPushWorkerOperations = WorkerOperations<typeof webPushOperations>;
