import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";
import * as approval from "./device-pairing-approval.kernel.js";
import * as core from "./device-pairing-core.kernel.js";
import type { DevicePairingCoreWorkerOperations } from "./device-pairing-core.worker-contract.js";
import * as tokens from "./device-pairing-tokens.kernel.js";
import type { SqliteWorkerCommand } from "./sqlite-worker-contract.js";

export function executeDevicePairingCoreMutation(
  command: Extract<
    SqliteWorkerCommand<DevicePairingCoreWorkerOperations>,
    { type: "devicePairing.approveBootstrap" }
  >,
  database: OpenClawStateDatabase,
): DevicePairingCoreWorkerOperations["devicePairing.approveBootstrap"]["output"];
export function executeDevicePairingCoreMutation(
  command: SqliteWorkerCommand<DevicePairingCoreWorkerOperations>,
  database: OpenClawStateDatabase,
): DevicePairingCoreWorkerOperations[keyof DevicePairingCoreWorkerOperations]["output"];
export function executeDevicePairingCoreMutation(
  command: SqliteWorkerCommand<DevicePairingCoreWorkerOperations>,
  database: OpenClawStateDatabase,
): DevicePairingCoreWorkerOperations[keyof DevicePairingCoreWorkerOperations]["output"] {
  switch (command.type) {
    case "devicePairing.request":
      return core.requestDevicePairingInWorker(command.input.request, command.input.nowMs);
    case "devicePairing.reject":
      return core.rejectDevicePairingInWorker(
        database,
        command.input.requestId,
        command.input.nowMs,
      );
    case "devicePairing.remove":
      return core.removePairedDeviceInWorker(command.input.deviceId, command.input.nowMs);
    case "devicePairing.pruneSilent":
      return core.pruneSupersededSilentPairedDevicesInWorker(command.input);
    case "devicePairing.removeRole":
      return core.removePairedDeviceRoleInWorker(command.input);
    case "devicePairing.updateMetadata":
      return core.updatePairedDeviceMetadataInWorker(
        command.input.deviceId,
        command.input.patch,
        command.input.nowMs,
      );
    case "devicePairing.updatePresence":
      return core.updatePairedDevicePresenceInWorker(
        command.input.deviceId,
        command.input.patch,
        command.input.expectedPairingGeneration,
      );
    case "devicePairing.approve":
      return approval.approveDevicePairingInWorker(
        command.input.requestId,
        command.input.options,
        command.input.nowMs,
      );
    case "devicePairing.approveBootstrap":
      return approval.approveBootstrapDevicePairingInWorker(
        command.input.requestId,
        command.input.bootstrapProfile,
        { accessMetadata: command.input.accessMetadata },
        command.input.nowMs,
      );
    case "devicePairing.verifyToken":
      return tokens.verifyDeviceTokenInWorker(command.input);
    case "devicePairing.ensureToken":
      return tokens.ensureDeviceTokenInWorker(command.input);
    case "devicePairing.rotateToken":
      return tokens.rotateDeviceTokenInWorker(command.input);
    case "devicePairing.revokeToken":
      return tokens.revokeDeviceTokenInWorker(command.input);
  }
  throw new Error("Unsupported device pairing mutation");
}
