import type { WorkerOperations } from "../state/worker-operation-registry.js";
import type { devicePairingOperations } from "./device-pairing-core.worker.js";

export type DevicePairingCoreWorkerOperations = WorkerOperations<typeof devicePairingOperations>;
