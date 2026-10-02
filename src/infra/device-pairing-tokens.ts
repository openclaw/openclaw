// Device token operations preserve live handshake authority through worker commit.
import type {
  RevokeDeviceTokenResult,
  RotateDeviceTokenResult,
} from "./device-pairing-core.types.js";
import { withDevicePairingLock } from "./device-pairing-lock.js";
import {
  DevicePairingAuthorityRefusedError,
  executeDevicePairingMutation,
} from "./device-pairing-worker.js";
import type { DeviceAuthToken } from "./device-pairing.types.js";

export {
  summarizeDeviceTokens,
  type DeviceAuthTokenSummary,
} from "./device-pairing-token-utils.js";
export type {
  RevokeDeviceTokenDenyReason,
  RotateDeviceTokenDenyReason,
} from "./device-pairing-core.types.js";

export async function verifyDeviceToken(params: {
  deviceId: string;
  token: string;
  role: string;
  scopes: string[];
  requiredSharedGatewaySessionGeneration?: string;
  baseDir?: string;
}): Promise<{ ok: boolean; reason?: string; issuer?: DeviceAuthToken["issuer"] }> {
  const { baseDir, ...input } = params;
  return await withDevicePairingLock(() =>
    executeDevicePairingMutation(
      { type: "devicePairing.verifyToken", input: { ...input, nowMs: Date.now() } },
      { baseDir },
    ),
  );
}

export async function ensureDeviceToken(params: {
  deviceId: string;
  role: string;
  scopes: string[];
  issuer?: DeviceAuthToken["issuer"];
  isIssuanceCurrent?: () => boolean;
  baseDir?: string;
}): Promise<DeviceAuthToken | null> {
  const { baseDir, isIssuanceCurrent, ...input } = params;
  return await withDevicePairingLock(async () => {
    try {
      return await executeDevicePairingMutation(
        { type: "devicePairing.ensureToken", input: { ...input, nowMs: Date.now() } },
        {
          baseDir,
          assertCurrent: () => {
            if (isIssuanceCurrent?.() === false) {
              throw new DevicePairingAuthorityRefusedError(
                "Device token issuance authority changed",
              );
            }
          },
        },
      );
    } catch (error) {
      if (error instanceof DevicePairingAuthorityRefusedError) {
        return null;
      }
      throw error;
    }
  });
}

export async function rotateDeviceToken(params: {
  deviceId: string;
  role: string;
  scopes?: string[];
  callerScopes?: readonly string[];
  baseDir?: string;
}): Promise<RotateDeviceTokenResult> {
  const { baseDir, ...input } = params;
  return await withDevicePairingLock(() =>
    executeDevicePairingMutation(
      { type: "devicePairing.rotateToken", input: { ...input, nowMs: Date.now() } },
      { baseDir },
    ),
  );
}

export async function revokeDeviceToken(params: {
  deviceId: string;
  role: string;
  callerScopes?: readonly string[];
  baseDir?: string;
}): Promise<RevokeDeviceTokenResult> {
  const { baseDir, ...input } = params;
  return await withDevicePairingLock(() =>
    executeDevicePairingMutation(
      { type: "devicePairing.revokeToken", input: { ...input, nowMs: Date.now() } },
      { baseDir },
    ),
  );
}
