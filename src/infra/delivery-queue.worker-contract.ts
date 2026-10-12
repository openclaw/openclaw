import type { WorkerOperations } from "../state/worker-operation-registry.js";
import type { deliveryQueueOperations } from "./delivery-queue.worker.js";

export type DeliveryQueueWorkerOperations = WorkerOperations<typeof deliveryQueueOperations>;
