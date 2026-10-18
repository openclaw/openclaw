import type { DeviceBootstrapOperations } from "./device-bootstrap.worker-kernel.js";
import type { DevicePairingCoreWorkerOperations } from "./device-pairing-core.worker-contract.js";
import type { DevicePairingNodeWorkerOperations } from "./device-pairing-node.worker-contract.js";

export type DevicePairingWorkerOperations = DevicePairingCoreWorkerOperations &
  DevicePairingNodeWorkerOperations &
  DeviceBootstrapOperations;
