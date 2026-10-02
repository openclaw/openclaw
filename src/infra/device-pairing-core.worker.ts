import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import * as approval from "./device-pairing-approval.kernel.js";
import * as core from "./device-pairing-core.kernel.js";
import { devicePairingMutation } from "./device-pairing-dispatch.worker.js";
import * as tokens from "./device-pairing-tokens.kernel.js";

export const devicePairingOperations = {
  "devicePairing.request": devicePairingMutation(
    (input: { request: Parameters<typeof core.requestDevicePairingInWorker>[0]; nowMs: number }) =>
      core.requestDevicePairingInWorker(input.request, input.nowMs),
  ),
  "devicePairing.reject": devicePairingMutation(
    (input: { requestId: string; nowMs: number }, { database }) =>
      core.rejectDevicePairingInWorker(database, input.requestId, input.nowMs),
  ),
  "devicePairing.remove": devicePairingMutation((input: { deviceId: string; nowMs: number }) =>
    core.removePairedDeviceInWorker(input.deviceId, input.nowMs),
  ),
  "devicePairing.pruneSilent": devicePairingMutation(
    (
      input: Omit<Parameters<typeof core.pruneSupersededSilentPairedDevicesInWorker>[0], "baseDir">,
    ) => core.pruneSupersededSilentPairedDevicesInWorker(input),
  ),
  "devicePairing.removeRole": devicePairingMutation(
    (input: Omit<Parameters<typeof core.removePairedDeviceRoleInWorker>[0], "baseDir">) =>
      core.removePairedDeviceRoleInWorker(input),
  ),
  "devicePairing.updateMetadata": devicePairingMutation(
    (input: {
      deviceId: string;
      patch: Parameters<typeof core.updatePairedDeviceMetadataInWorker>[1];
      expectedPairing?: Parameters<typeof core.updatePairedDeviceMetadataInWorker>[3];
    }) =>
      core.updatePairedDeviceMetadataInWorker(
        input.deviceId,
        input.patch,
        undefined,
        input.expectedPairing,
      ),
  ),
  "devicePairing.updatePresence": devicePairingMutation(
    (input: {
      deviceId: string;
      patch: Parameters<typeof core.updatePairedDevicePresenceInWorker>[1];
      expectedPairingGeneration: Parameters<typeof core.updatePairedDevicePresenceInWorker>[2];
    }) =>
      core.updatePairedDevicePresenceInWorker(
        input.deviceId,
        input.patch,
        input.expectedPairingGeneration,
      ),
  ),
  "devicePairing.approve": devicePairingMutation(
    (input: {
      requestId: string;
      options?: Parameters<typeof approval.approveDevicePairingInWorker>[1];
      nowMs: number;
    }) => approval.approveDevicePairingInWorker(input.requestId, input.options, input.nowMs),
  ),
  "devicePairing.approveBootstrap": devicePairingMutation(
    (
      input: {
        requestId: string;
        bootstrapProfile: Parameters<typeof approval.approveBootstrapDevicePairingInWorker>[1];
        accessMetadata?: NonNullable<
          Parameters<typeof approval.approveBootstrapDevicePairingInWorker>[2]
        >["accessMetadata"];
        nowMs: number;
      },
      { recordTokenReplacement },
    ) => {
      const result = approval.approveBootstrapDevicePairingInWorker(
        input.requestId,
        input.bootstrapProfile,
        { accessMetadata: input.accessMetadata },
        input.nowMs,
      );
      if (result.result?.status === "approved" && result.replacedRoles.length > 0) {
        recordTokenReplacement({
          deviceId: result.result.device.deviceId,
          roles: result.replacedRoles,
        });
      }
      return result;
    },
  ),
  "devicePairing.verifyToken": devicePairingMutation(
    (input: Omit<Parameters<typeof tokens.verifyDeviceTokenInWorker>[0], "baseDir">) =>
      tokens.verifyDeviceTokenInWorker(input),
  ),
  "devicePairing.ensureToken": devicePairingMutation(
    (input: Omit<Parameters<typeof tokens.ensureDeviceTokenInWorker>[0], "baseDir">) =>
      tokens.ensureDeviceTokenInWorker(input),
  ),
  "devicePairing.rotateToken": devicePairingMutation(
    (input: Omit<Parameters<typeof tokens.rotateDeviceTokenInWorker>[0], "baseDir">) =>
      tokens.rotateDeviceTokenInWorker(input),
  ),
  "devicePairing.revokeToken": devicePairingMutation(
    (input: Omit<Parameters<typeof tokens.revokeDeviceTokenInWorker>[0], "baseDir">) =>
      tokens.revokeDeviceTokenInWorker(input),
  ),
} satisfies WorkerOperationHandlers;
