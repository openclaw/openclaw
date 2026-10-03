import type { WorkerOperations } from "../state/worker-operation-registry.js";
import type { nodePairingOperations } from "./device-pairing-node.worker.js";

export type DevicePairingNodeWorkerOperations = WorkerOperations<typeof nodePairingOperations>;
