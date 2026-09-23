import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import { resolveMissingRequestedScope, roleScopesAllow } from "../shared/operator-scope-compat.js";
// Device token issuance, verification, rotation, and revocation for paired devices.
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
  cloneDevicePairingTokens,
  loadDevicePairingStateForMutation,
  normalizeDevicePairingId,
  normalizeDevicePairingRole,
} from "./device-pairing-state.kernel.js";
import {
  persistDevicePairingStoreState as persistState,
  type DevicePairingStoreState,
} from "./device-pairing-store.js";
import { createDeviceAuthToken } from "./device-pairing-token-utils.js";
import type { DeviceAuthToken, PairedDevice } from "./device-pairing.types.js";
import { verifyPairingToken } from "./pairing-token.js";

const SHARED_GATEWAY_AUTH_ISSUER_KIND = "shared-gateway-auth";
const BROWSER_DEVICE_CLIENT_IDS = new Set(["openclaw-control-ui", "webchat-ui"]);
const BROWSER_DEVICE_CLIENT_MODE = "webchat";

function getPairedDeviceFromState(
  state: DevicePairingStoreState,
  deviceId: string,
): PairedDevice | null {
  return state.pairedByDeviceId[normalizeDevicePairingId(deviceId)] ?? null;
}

function isBrowserRelatedPairedDevice(device: Pick<PairedDevice, "clientId" | "clientMode">) {
  const clientMode = device.clientMode?.trim().toLowerCase();
  if (clientMode === BROWSER_DEVICE_CLIENT_MODE) {
    return true;
  }
  const clientId = device.clientId?.trim().toLowerCase();
  return clientId ? BROWSER_DEVICE_CLIENT_IDS.has(clientId) : false;
}

function deviceTokenIssuerMatches(
  entry: DeviceAuthToken,
  issuer: DeviceAuthToken["issuer"] | undefined,
): boolean {
  if (!issuer) {
    return !entry.issuer;
  }
  return entry.issuer?.kind === issuer.kind && entry.issuer.generation === issuer.generation;
}

function resolveApprovedDeviceScopeBaseline(device: PairedDevice): string[] | null {
  const baseline = device.approvedScopes ?? device.scopes;
  if (!Array.isArray(baseline)) {
    return null;
  }
  return normalizeDeviceAuthScopes(baseline);
}

function scopesWithinApprovedDeviceBaseline(params: {
  role: string;
  scopes: readonly string[];
  approvedScopes: readonly string[] | null;
}): boolean {
  if (!params.approvedScopes) {
    return false;
  }
  return roleScopesAllow({
    role: params.role,
    requestedScopes: params.scopes,
    allowedScopes: params.approvedScopes,
  });
}

/** Verify a device role token, scope it to the approval baseline, and mark last use. */
export function verifyDeviceTokenInWorker(params: {
  deviceId: string;
  token: string;
  role: string;
  scopes: string[];
  requiredSharedGatewaySessionGeneration?: string;
  nowMs: number;
  baseDir?: string;
}): { ok: boolean; reason?: string; issuer?: DeviceAuthToken["issuer"] } {
  const state = loadDevicePairingStateForMutation(params.nowMs, params.baseDir);
  const device = getPairedDeviceFromState(state, params.deviceId);
  if (!device) {
    return { ok: false, reason: "device-not-paired" };
  }
  const role = normalizeDevicePairingRole(params.role);
  if (!role) {
    return { ok: false, reason: "role-missing" };
  }
  const entry = device.tokens?.[role];
  if (!entry) {
    return { ok: false, reason: "token-missing" };
  }
  if (entry.revokedAtMs) {
    return { ok: false, reason: "token-revoked" };
  }
  if (!verifyPairingToken(params.token, entry.token)) {
    return { ok: false, reason: "token-mismatch" };
  }
  if (
    entry.issuer?.kind === SHARED_GATEWAY_AUTH_ISSUER_KIND &&
    entry.issuer.generation !== params.requiredSharedGatewaySessionGeneration
  ) {
    return { ok: false, reason: "issuer-generation-stale" };
  }
  if (
    !entry.issuer &&
    params.requiredSharedGatewaySessionGeneration !== undefined &&
    isBrowserRelatedPairedDevice(device)
  ) {
    return { ok: false, reason: "legacy-browser-token" };
  }
  const approvedScopes = resolveApprovedDeviceScopeBaseline(device);
  if (
    !scopesWithinApprovedDeviceBaseline({
      role,
      scopes: entry.scopes,
      approvedScopes,
    })
  ) {
    return { ok: false, reason: "scope-mismatch" };
  }
  const requestedScopes = normalizeDeviceAuthScopes(params.scopes);
  if (!roleScopesAllow({ role, requestedScopes, allowedScopes: entry.scopes })) {
    return { ok: false, reason: "scope-mismatch" };
  }
  const now = params.nowMs;
  entry.lastUsedAtMs = now;
  device.tokens ??= {};
  device.tokens[role] = entry;
  device.lastSeenAtMs = now;
  device.lastSeenReason = "device-token-auth";
  state.pairedByDeviceId[device.deviceId] = device;
  persistState(state, params.baseDir, "paired");
  return entry.issuer ? { ok: true, issuer: entry.issuer } : { ok: true };
}

/** Return a reusable token for a role or issue one within the approved scope baseline. */
export function ensureDeviceTokenInWorker(params: {
  deviceId: string;
  role: string;
  scopes: string[];
  issuer?: DeviceAuthToken["issuer"];
  nowMs: number;
  baseDir?: string;
}): DeviceAuthToken | null {
  const state = loadDevicePairingStateForMutation(params.nowMs, params.baseDir);
  requestDevicePairingMutationAdmission({ kind: "pairing-token-issuance" });
  const requestedScopes = normalizeDeviceAuthScopes(params.scopes);
  const context = resolveDeviceTokenUpdateContext({
    state,
    deviceId: params.deviceId,
    role: params.role,
  });
  if (!context) {
    return null;
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
    return null;
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
      return existing;
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
  state.pairedByDeviceId[device.deviceId] = device;
  persistState(state, params.baseDir, "paired");
  return next;
}

function resolveDeviceTokenUpdateContext(params: {
  state: DevicePairingStoreState;
  deviceId: string;
  role: string;
}): {
  device: PairedDevice;
  role: string;
  tokens: Record<string, DeviceAuthToken>;
  existing: DeviceAuthToken | undefined;
} | null {
  const device = getPairedDeviceFromState(params.state, params.deviceId);
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
  const tokens = cloneDevicePairingTokens(device);
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
  baseDir?: string;
}): RotateDeviceTokenResult {
  const state = loadDevicePairingStateForMutation(params.nowMs, params.baseDir);
  const context = resolveDeviceTokenUpdateContext({
    state,
    deviceId: params.deviceId,
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
  persistState(state, params.baseDir, "paired", { retiredNodeToken });
  return { ok: true, entry: next };
}

/** Revoke one active role token after optional caller-scope authorization. */
export function revokeDeviceTokenInWorker(params: {
  deviceId: string;
  role: string;
  callerScopes?: readonly string[];
  nowMs: number;
  baseDir?: string;
}): RevokeDeviceTokenResult {
  const state = loadDevicePairingStateForMutation(params.nowMs, params.baseDir);
  const context = resolveDeviceTokenUpdateContext({
    state,
    deviceId: params.deviceId,
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
  persistState(state, params.baseDir, "paired");
  return { ok: true, entry };
}
