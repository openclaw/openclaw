import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import {
  listApprovedPairedDeviceRoles,
  resolveApprovedDeviceScopeBaseline,
} from "./device-pairing-identity.js";
import type { DeviceAuthToken, PairedDevice } from "./device-pairing.types.js";
import { verifyPairingToken } from "./pairing-token.js";

export type DeviceTokenVerification = {
  ok: boolean;
  reason?: string;
  issuer?: DeviceAuthToken["issuer"];
};
export type DeviceTokenRequest = {
  role: string;
  scopes: string[];
  issuer?: DeviceAuthToken["issuer"];
};

const SHARED_GATEWAY_AUTH_ISSUER_KIND = "shared-gateway-auth";
const BROWSER_DEVICE_CLIENT_IDS = new Set(["openclaw-control-ui", "webchat-ui"]);
const BROWSER_DEVICE_CLIENT_MODE = "webchat";

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

export function scopesWithinApprovedDeviceBaseline(params: {
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

export function verifyPairedDeviceToken(
  device: PairedDevice | null,
  params: {
    token: string;
    role: string;
    scopes: string[];
    requiredSharedGatewaySessionGeneration?: string;
  },
): DeviceTokenVerification {
  if (!device) {
    return { ok: false, reason: "device-not-paired" };
  }
  const role = params.role.trim();
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
  return entry.issuer ? { ok: true, issuer: entry.issuer } : { ok: true };
}

export function reusablePairedDeviceToken(
  device: PairedDevice | null,
  params: DeviceTokenRequest,
): DeviceAuthToken | null {
  const role = params.role.trim();
  const existing = device?.tokens?.[role];
  const approvedScopes = device ? resolveApprovedDeviceScopeBaseline(device) : null;
  const requestedScopes = normalizeDeviceAuthScopes(params.scopes);
  return device &&
    role &&
    listApprovedPairedDeviceRoles(device).includes(role) &&
    existing &&
    !existing.revokedAtMs &&
    scopesWithinApprovedDeviceBaseline({
      role,
      scopes: requestedScopes,
      approvedScopes,
    }) &&
    scopesWithinApprovedDeviceBaseline({ role, scopes: existing.scopes, approvedScopes }) &&
    deviceTokenIssuerMatches(existing, params.issuer) &&
    roleScopesAllow({
      role,
      requestedScopes,
      allowedScopes: existing.scopes,
    })
    ? existing
    : null;
}
