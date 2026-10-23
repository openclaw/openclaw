import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
// Device token operations preserve live handshake authority through worker commit.
import type {
  RevokeDeviceTokenResult,
  RotateDeviceTokenResult,
} from "./device-pairing-core.types.js";
import { withDevicePairingLock } from "./device-pairing-lock.js";
import { readCurrentPairedDevice } from "./device-pairing-store-readonly.js";
import {
  reusablePairedDeviceToken,
  verifyPairedDeviceToken,
} from "./device-pairing-token-policy.js";
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
  return readCurrentPairedDevice(
    input.deviceId,
    (device) => {
      const result = verifyPairedDeviceToken(device, input);
      if (result.ok) {
        recordDeviceTokenUse(input, baseDir);
      }
      return result;
    },
    baseDir,
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
  return readCurrentPairedDevice(
    input.deviceId,
    (device) => {
      if (isIssuanceCurrent?.() === false) {
        return null;
      }
      const reusable = reusablePairedDeviceToken(device, input);
      if (reusable) {
        return reusable;
      }
      return executeDevicePairingMutation(
        { type: "devicePairing.ensureToken", input: { ...input, nowMs: Date.now() } },
        {
          baseDir,
          onAuthorityRefused: () => null,
          assertCurrent: () => {
            if (isIssuanceCurrent?.() === false) {
              throw new DevicePairingAuthorityRefusedError(
                "Device token issuance authority changed",
              );
            }
          },
        },
      );
    },
    baseDir,
  );
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

const uses = resolveGlobalSingleton(Symbol.for("openclaw.deviceTokenUses"), () => {
  const pending = new Map<
    string,
    {
      input?: Parameters<typeof verifyPairedDeviceToken>[1] & { deviceId: string; nowMs: number };
      done: Promise<void>;
    }
  >();
  registerOpenClawStateDatabaseAsyncResource({
    async close(identity) {
      await Promise.all(
        [...pending].flatMap(([key, entry]) =>
          !identity || key.startsWith(`${identity.key}:`) ? [entry.done] : [],
        ),
      );
    },
  });
  return pending;
});
const log = createSubsystemLogger("gateway/device-token");

function recordDeviceTokenUse(
  input: Parameters<typeof verifyPairedDeviceToken>[1] & { deviceId: string },
  baseDir?: string,
): void {
  const context = captureOpenClawStateWorkerContext(
    baseDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } } : {},
  );
  const key = `${context.admission.identity.key}:${input.deviceId.trim()}:${input.role.trim()}`;
  const latest = { ...input, nowMs: Date.now() };
  const pending = uses.get(key);
  if (pending) {
    pending.input = latest;
    return;
  }
  const entry: NonNullable<ReturnType<typeof uses.get>> = {
    input: latest,
    done: Promise.resolve(),
  };
  uses.set(key, entry);
  entry.done = (async () => {
    while (entry.input) {
      const next = entry.input;
      entry.input = undefined;
      await executeDevicePairingMutation(
        { type: "devicePairing.verifyToken", input: next },
        { context },
      );
    }
  })()
    .catch((error: unknown) => log.warn(`Device token last-use recording failed: ${String(error)}`))
    .finally(() => uses.delete(key));
}
