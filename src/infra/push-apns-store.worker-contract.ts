import type { WorkerOperations } from "../state/worker-operation-registry.js";
import type { apnsOperations } from "./push-apns-store.worker.js";

export type ApnsRegistrationWorkerOperations = WorkerOperations<typeof apnsOperations>;
