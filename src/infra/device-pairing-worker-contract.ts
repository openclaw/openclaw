import type { DeviceBootstrapOperations } from "./device-bootstrap.worker-types.js";
import type { DevicePairingCoreWorkerOperations } from "./device-pairing-core.worker-contract.js";
import type { DevicePairingNodeWorkerOperations } from "./device-pairing-node.worker-contract.js";
import type { SqliteWorkerCommand } from "./sqlite-worker-contract.js";

export type DevicePairingWorkerOperations = DevicePairingCoreWorkerOperations &
  DevicePairingNodeWorkerOperations &
  DeviceBootstrapOperations;
export type DevicePairingMutationCommand = SqliteWorkerCommand<DevicePairingWorkerOperations>;

export function isDevicePairingMutationCommand(command: {
  type: string;
}): command is DevicePairingMutationCommand {
  return (
    command.type.startsWith("devicePairing.") ||
    command.type.startsWith("node.") ||
    command.type.startsWith("bootstrap.")
  );
}
