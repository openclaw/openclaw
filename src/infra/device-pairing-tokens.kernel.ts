import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import { resolveMissingRequestedScope, roleScopesAllow } from "../shared/operator-scope-compat.js";
import type {
  RotateDeviceTokenResult,
  RevokeDeviceTokenResult,
} from "./device-pairing-core.types.js";
import {
  clearNodePairingGenerationState,
  listApprovedPairedDeviceRoles,
  resolveNodePairingGeneration,
} from "./device-pairing-identity.js";
import { requestDevicePairingMutationAdmission } from "./device-pairing-mutation.worker.js";
import {
  loadDevicePairingStateForMutation,
  normalizeDevicePairingRole,
} from "./device-pairing-state.kernel.js";
import {
  persistDevicePairingStoreState as persistState,
  updatePairedDeviceInTransaction,
} from "./device-pairing-store.js";
import {
  createDeviceAuthToken,
  verifyDeviceTokenAgainstDevice,
  resolveApprovedDeviceScopeBaseline,
  scopesWithinApprovedDeviceBaseline,
} from "./device-pairing-token-utils.js";
import type { DeviceAuthToken, PairedDevice } from "./device-pairing.types.js";

function deviceTokenIssuerMatches(
  entry: DeviceAuthToken,
  issuer: DeviceAuthToken["issuer"] | undefined,
): boolean {
  if (!issuer) {
    return !entry.issuer;
  }
  return entry.issuer?.kind === issuer.kind && entry.issuer.generation === issuer.generation;
}

/** Verify a device role token, scope it to the approval baseline, and mark last use. */
export function verifyDeviceTokenInWorker(params: {
  deviceId: string;
  token: string;
  role: string;
  scopes: string[];
  requiredSharedGatewaySessionGeneration?: string;
  nowMs: number;
}): { ok: boolean; reason?: string; issuer?: DeviceAuthToken["issuer"] } {
  return updatePairedDeviceInTransaction<ReturnType<typeof verifyDeviceTokenInWorker>>(
    params.deviceId,
    (device) => {
      const verified = verifyDeviceTokenAgainstDevice(device, params);
      if (!verified.ok) {
        return { value: verified };
      }
      const { device: admittedDevice, role, entry } = verified;
      return {
        value: entry.issuer ? { ok: true, issuer: entry.issuer } : { ok: true },
        patch: {
          tokens: { ...admittedDevice.tokens, [role]: { ...entry, lastUsedAtMs: params.nowMs } },
          lastSeenAtMs: params.nowMs,
          lastSeenReason: "device-token-auth",
        },
      };
    },
  );
}

/** Return a reusable token for a role or issue one within the approved scope baseline. */
export function ensureDeviceTokenInWorker(params: {
  deviceId: string;
  role: string;
  scopes: string[];
  issuer?: DeviceAuthToken["issuer"];
  nowMs: number;
}): DeviceAuthToken | null {
  return updatePairedDeviceInTransaction<DeviceAuthToken | null>(params.deviceId, (paired) => {
    requestDevicePairingMutationAdmission({ kind: "pairing-token-issuance" });
    const requestedScopes = normalizeDeviceAuthScopes(params.scopes);
    const context = resolveDeviceTokenUpdateContext({
      device: paired,
      role: params.role,
    });
    if (!context) {
      return { value: null };
    }
    const { device, role, tokens, existing } = context;
    const previousNodeGeneration = resolveNodePairingGeneration(device);
    const approvedScopes = resolveApprovedDeviceScopeBaseline(device);
    if (
      !scopesWithinApprovedDeviceBaseline({
        role,
        scopes: requestedScopes,
        approvedScopes,
      })
    ) {
      return { value: null };
    }
    if (existing && !existing.revokedAtMs) {
      const existingWithinApproved = scopesWithinApprovedDeviceBaseline({
        role,
        scopes: existing.scopes,
        approvedScopes,
      });
      const issuerAllowsReuse = deviceTokenIssuerMatches(existing, params.issuer);
      if (
        existingWithinApproved &&
        issuerAllowsReuse &&
        roleScopesAllow({ role, requestedScopes, allowedScopes: existing.scopes })
      ) {
        return { value: existing };
      }
    }
    const now = params.nowMs;
    const next = createDeviceAuthToken({
      role,
      scopes: requestedScopes,
      issuer: params.issuer,
      existing,
      now,
      rotatedAtMs: existing ? now : undefined,
    });
    tokens[role] = next;
    device.tokens = tokens;
    clearNodePairingGenerationState(device, previousNodeGeneration);
    return { value: next, patch: { tokens, nodeSurface: device.nodeSurface } };
  });
}

function resolveDeviceTokenUpdateContext(params: { device: PairedDevice | null; role: string }): {
  device: PairedDevice;
  role: string;
  tokens: Record<string, DeviceAuthToken>;
  existing: DeviceAuthToken | undefined;
} | null {
  const device = params.device;
  if (!device) {
    return null;
  }
  const role = normalizeDevicePairingRole(params.role);
  if (!role) {
    return null;
  }
  // Token issuance and rotation must stay inside the role set that pairing
  // approval recorded for this device.
  if (!listApprovedPairedDeviceRoles(device).includes(role)) {
    return null;
  }
  const tokens = { ...device.tokens };
  const existing = tokens[role];
  return { device, role, tokens, existing };
}

/** Rotate a role token inside the device's approved scope baseline. */
export function rotateDeviceTokenInWorker(params: {
  deviceId: string;
  role: string;
  scopes?: string[];
  callerScopes?: readonly string[];
  nowMs: number;
}): RotateDeviceTokenResult {
  const state = loadDevicePairingStateForMutation(params.nowMs);
  const context = resolveDeviceTokenUpdateContext({
    device: state.pairedByDeviceId[params.deviceId.trim()] ?? null,
    role: params.role,
  });
  if (!context) {
    return { ok: false, reason: "unknown-device-or-role" };
  }
  const { device, role, tokens, existing } = context;
  const previousNodeGeneration = resolveNodePairingGeneration(device);
  const requestedScopes = normalizeDeviceAuthScopes(
    params.scopes ?? existing?.scopes ?? device.scopes,
  );
  const approvedScopes = resolveApprovedDeviceScopeBaseline(device);
  if (!approvedScopes) {
    return { ok: false, reason: "missing-approved-scope-baseline" };
  }
  if (
    !scopesWithinApprovedDeviceBaseline({
      role,
      scopes: requestedScopes,
      approvedScopes,
    })
  ) {
    return { ok: false, reason: "scope-outside-approved-baseline" };
  }
  if (params.callerScopes) {
    const missingScope = resolveMissingRequestedScope({
      role,
      requestedScopes,
      allowedScopes: params.callerScopes,
    });
    if (missingScope) {
      return { ok: false, reason: "caller-missing-scope", scope: missingScope };
    }
  }
  const now = params.nowMs;
  const next = createDeviceAuthToken({
    role,
    scopes: requestedScopes,
    existing,
    preserveExistingIssuer: true,
    now,
    rotatedAtMs: now,
  });
  tokens[role] = next;
  device.tokens = tokens;
  clearNodePairingGenerationState(device, previousNodeGeneration);
  state.pairedByDeviceId[device.deviceId] = device;
  const retiredNodeToken =
    role === "node" &&
    params.scopes !== undefined &&
    requestedScopes.length === 0 &&
    existing &&
    !scopesWithinApprovedDeviceBaseline({
      role,
      scopes: existing.scopes,
      approvedScopes,
    })
      ? { deviceId: device.deviceId, expectedToken: existing.token }
      : undefined;
  // Retire the matching legacy cache with the token, even if the CLI loses its response.
  persistState(state, undefined, "paired", { retiredNodeToken });
  return { ok: true, entry: next };
}

/** Revoke one active role token after optional caller-scope authorization. */
export function revokeDeviceTokenInWorker(params: {
  deviceId: string;
  role: string;
  callerScopes?: readonly string[];
  nowMs: number;
}): RevokeDeviceTokenResult {
  const state = loadDevicePairingStateForMutation(params.nowMs);
  const context = resolveDeviceTokenUpdateContext({
    device: state.pairedByDeviceId[params.deviceId.trim()] ?? null,
    role: params.role,
  });
  if (!context || !context.existing) {
    return { ok: false, reason: "unknown-device-or-role" };
  }
  const { device, role, tokens, existing } = context;
  const previousNodeGeneration = resolveNodePairingGeneration(device);
  const targetScopes = normalizeDeviceAuthScopes(
    Array.isArray(existing.scopes) ? existing.scopes : device.scopes,
  );
  if (params.callerScopes) {
    const missingScope = resolveMissingRequestedScope({
      role,
      requestedScopes: targetScopes,
      allowedScopes: params.callerScopes,
    });
    if (missingScope) {
      return { ok: false, reason: "caller-missing-scope", scope: missingScope };
    }
  }
  const entry = { ...existing, revokedAtMs: params.nowMs };
  tokens[role] = entry;
  device.tokens = tokens;
  clearNodePairingGenerationState(device, previousNodeGeneration);
  state.pairedByDeviceId[device.deviceId] = device;
  persistState(state, undefined, "paired");
  return { ok: true, entry };
}
