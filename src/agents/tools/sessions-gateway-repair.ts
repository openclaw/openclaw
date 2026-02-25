import {
  type CallGatewayOptions,
  callGateway,
  isLocalLoopbackGateway,
} from "../../gateway/call.js";
import { loadOrCreateDeviceIdentity } from "../../infra/device-identity.js";
import {
  approveDevicePairing,
  listDevicePairing,
  type DevicePairingPendingRequest,
} from "../../infra/device-pairing.js";

const REPAIR_REQUEST_MAX_AGE_MS = 120_000;

export class GatewayRepairError extends Error {
  hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = "GatewayRepairError";
    this.hint = hint;
  }
}

export function isPairingRequiredError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const msg = err.message.toLowerCase();
  return msg.includes("pairing required") || (msg.includes("1008") && msg.includes("pairing"));
}

export function findRepairCandidate(
  pending: DevicePairingPendingRequest[],
  localDeviceId: string,
  now: number,
): DevicePairingPendingRequest | null {
  for (const request of pending) {
    // Check isRepair flag
    if (request.isRepair !== true) {
      continue;
    }
    // Check deviceId match
    if (request.deviceId !== localDeviceId) {
      continue;
    }
    // Check role is operator
    if (request.role !== "operator") {
      continue;
    }
    // Check timestamp within window
    const ageMs = now - request.ts;
    if (ageMs > REPAIR_REQUEST_MAX_AGE_MS) {
      continue;
    }
    return request;
  }
  return null;
}

export type GatewayRepairOptions = {
  localDeviceId?: string;
  baseDir?: string;
};

async function resolveLocalDeviceId(): Promise<string> {
  const identity = loadOrCreateDeviceIdentity();
  return identity.deviceId;
}

export async function callGatewayWithRepairApproval<T = Record<string, unknown>>(
  opts: CallGatewayOptions,
  repairOpts?: GatewayRepairOptions,
): Promise<T> {
  try {
    return await callGateway<T>(opts);
  } catch (err) {
    // Only attempt repair for pairing required errors
    if (!isPairingRequiredError(err)) {
      throw err;
    }
    // Only attempt repair in local loopback mode
    if (!isLocalLoopbackGateway(opts)) {
      throw err;
    }
    // Find the repair candidate
    const localDeviceId = repairOpts?.localDeviceId ?? (await resolveLocalDeviceId());
    const pairing = await listDevicePairing(repairOpts?.baseDir);
    const now = Date.now();
    const candidate = findRepairCandidate(pairing.pending, localDeviceId, now);
    if (!candidate) {
      throw new GatewayRepairError(
        "pairing required but no valid repair candidate found",
        "Run 'openclaw devices list' to check pending approvals, or 'openclaw devices approve <requestId>' to manually approve.",
      );
    }
    // Approve the repair request
    const approval = await approveDevicePairing(candidate.requestId, repairOpts?.baseDir);
    if (!approval) {
      throw new GatewayRepairError(
        "pairing required but repair approval failed",
        "Run 'openclaw devices approve <requestId>' to manually approve.",
      );
    }
    // Retry the call
    return await callGateway<T>(opts);
  }
}
