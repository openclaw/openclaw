import { resolveStateDir } from "../config/paths.js";
import { isProgressCardRendererClient } from "../utils/message-channel.js";
// Device pairing owns the worker operations and publishes their committed facts.
import {
  invalidatePairedCardRendererCache,
  readPairedCardRendererCache,
} from "./device-pairing-card-renderer.js";
import type {
  PairedDeviceMetadataPatch,
  PrunedSupersededPairedDevice,
  RequestDevicePairingResult,
} from "./device-pairing-core.types.js";
import type { NodePairingGeneration } from "./device-pairing-identity.js";
import { withDevicePairingLock } from "./device-pairing-lock.js";
import { loadDevicePairingStateForMutation } from "./device-pairing-state.kernel.js";
import {
  listDevicePairingStoreRecordsReadOnly,
  loadPairedDevicePairingStoreRecordReadOnly,
  loadPendingDevicePairingStoreRecordReadOnly,
} from "./device-pairing-store-readonly.js";
import { persistDevicePairingStoreState } from "./device-pairing-store.js";
import {
  DevicePairingAuthorityRefusedError,
  executeDevicePairingMutation,
} from "./device-pairing-worker.js";
import type { DevicePairingPendingRequest, PairedDevice } from "./device-pairing.types.js";

export {
  clearNodePairingGenerationState,
  hasEffectivePairedDeviceRole,
  listApprovedPairedDeviceRoles,
  listEffectivePairedDeviceRoles,
  resolveNodePairingGeneration,
  resolveNodePairingState,
  type NodePairingGeneration,
  type NodePairingState,
} from "./device-pairing-identity.js";
export type { PrunedSupersededPairedDevice } from "./device-pairing-core.types.js";
export type {
  DeviceAuthToken,
  DevicePairingPendingRequest,
  PairedDevice,
} from "./device-pairing.types.js";

/** Return whether this Gateway has a paired client that can render progress cards. */
export function hasPairedCardRenderer(baseDir?: string): Promise<boolean> {
  const stateDir = baseDir ?? resolveStateDir();
  return readPairedCardRendererCache(stateDir, () =>
    listDevicePairingReadOnly(stateDir)
      .then(({ paired }) => paired.some(isProgressCardRendererClient))
      .catch(() => false),
  );
}

/** Boot/Doctor migrations retain their synchronous snapshot transaction under the pairing lock. */
export async function withPairedDeviceRecords<T>(
  baseDir: string | undefined,
  operate: (
    pairedByDeviceId: Record<string, PairedDevice>,
  ) => { value: T; persist: boolean } | Promise<{ value: T; persist: boolean }>,
): Promise<T> {
  return await withDevicePairingLock(async () => {
    const state = loadDevicePairingStateForMutation(Date.now(), baseDir);
    const outcome = await operate(state.pairedByDeviceId);
    if (outcome.persist) {
      persistDevicePairingStoreState(state, baseDir, "paired");
      invalidatePairedCardRendererCache();
    }
    return outcome.value;
  });
}

export function listDevicePairing(baseDir?: string) {
  return listDevicePairingStoreRecordsReadOnly(baseDir, true);
}

/** List pairing state without creating or migrating shared state. */
export function listDevicePairingReadOnly(baseDir?: string) {
  return listDevicePairingStoreRecordsReadOnly(baseDir);
}

export function getPairedDevice(deviceId: string, baseDir?: string): Promise<PairedDevice | null> {
  return loadPairedDevicePairingStoreRecordReadOnly(deviceId, baseDir);
}

export function getPendingDevicePairing(requestId: string, baseDir?: string) {
  return loadPendingDevicePairingStoreRecordReadOnly(requestId, baseDir);
}

export async function requestDevicePairing(
  req: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">,
  baseDir?: string,
): Promise<RequestDevicePairingResult> {
  return await withDevicePairingLock(() =>
    executeDevicePairingMutation(
      { type: "devicePairing.request", input: { request: req, nowMs: Date.now() } },
      { baseDir },
    ),
  );
}

export async function rejectDevicePairing(requestId: string, baseDir?: string) {
  return await withDevicePairingLock(() =>
    executeDevicePairingMutation(
      { type: "devicePairing.reject", input: { requestId, nowMs: Date.now() } },
      { baseDir },
    ),
  );
}

export async function removePairedDevice(deviceId: string, baseDir?: string) {
  return await withDevicePairingLock(() =>
    executeDevicePairingMutation(
      { type: "devicePairing.remove", input: { deviceId, nowMs: Date.now() } },
      { baseDir },
    ),
  );
}

export async function pruneSupersededSilentPairedDevices(params: {
  deviceId: string;
  baseDir?: string;
  isDeviceConnected?: (deviceId: string) => boolean;
  nowMs?: number;
}): Promise<PrunedSupersededPairedDevice[]> {
  return await withDevicePairingLock(async () => {
    const protectedDeviceIds = params.isDeviceConnected
      ? (await listDevicePairing(params.baseDir)).paired
          .filter((device) => params.isDeviceConnected?.(device.deviceId))
          .map((device) => device.deviceId)
      : [];
    try {
      return await executeDevicePairingMutation(
        {
          type: "devicePairing.pruneSilent",
          input: {
            deviceId: params.deviceId,
            protectedDeviceIds,
            nowMs: params.nowMs ?? Date.now(),
          },
        },
        {
          baseDir: params.baseDir,
          admit: (facts) => {
            if (
              facts.kind === "pairing-prune" &&
              facts.deviceIds.some((deviceId) => params.isDeviceConnected?.(deviceId))
            ) {
              throw new DevicePairingAuthorityRefusedError(
                "Pairing prune candidate connected before commit",
              );
            }
          },
        },
      );
    } catch (error) {
      if (error instanceof DevicePairingAuthorityRefusedError) {
        return [];
      }
      throw error;
    }
  });
}

export async function removePairedDeviceRole(params: {
  deviceId: string;
  role: string;
  baseDir?: string;
}) {
  return await withDevicePairingLock(() =>
    executeDevicePairingMutation(
      {
        type: "devicePairing.removeRole",
        input: { deviceId: params.deviceId, role: params.role, nowMs: Date.now() },
      },
      { baseDir: params.baseDir },
    ),
  );
}

export async function updatePairedDeviceMetadata(
  deviceId: string,
  patch: Partial<PairedDeviceMetadataPatch>,
  baseDir?: string,
): Promise<boolean> {
  return await withDevicePairingLock(() =>
    executeDevicePairingMutation(
      { type: "devicePairing.updateMetadata", input: { deviceId, patch, nowMs: Date.now() } },
      { baseDir },
    ),
  );
}

export async function updatePairedDevicePresence(
  deviceId: string,
  patch: { lastSeenAtMs: number; lastSeenReason: string },
  expectedPairingGeneration: NodePairingGeneration,
  baseDir?: string,
): Promise<boolean> {
  return await executeDevicePairingMutation(
    { type: "devicePairing.updatePresence", input: { deviceId, patch, expectedPairingGeneration } },
    { baseDir },
  );
}
