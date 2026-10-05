import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import type { DeviceAuthToken, PairedDevice } from "./device-pairing.types.js";
import { generatePairingToken, verifyPairingToken } from "./pairing-token.js";

const OPERATOR_SCOPE_PREFIX = "operator.";

/** Redacted token metadata safe for list/status responses. */
export type DeviceAuthTokenSummary = Pick<
  DeviceAuthToken,
  "role" | "scopes" | "createdAtMs" | "rotatedAtMs" | "revokedAtMs" | "lastUsedAtMs"
>;

/** Build one freshly generated role token while preserving requested lifecycle fields. */
export function createDeviceAuthToken(params: {
  role: string;
  scopes: string[];
  issuer?: DeviceAuthToken["issuer"];
  existing?: DeviceAuthToken;
  preserveExistingIssuer?: boolean;
  now: number;
  rotatedAtMs?: number;
}): DeviceAuthToken {
  return {
    token: generatePairingToken(),
    role: params.role,
    scopes: params.scopes,
    issuer: params.issuer ?? (params.preserveExistingIssuer ? params.existing?.issuer : undefined),
    createdAtMs: params.existing?.createdAtMs ?? params.now,
    rotatedAtMs: params.rotatedAtMs,
    revokedAtMs: undefined,
    lastUsedAtMs: params.existing?.lastUsedAtMs,
  };
}

/** Select scopes owned by one device-token role. */
export function resolveRoleTokenScopes(role: string, scopes: string[] | undefined): string[] {
  const normalized = normalizeDeviceAuthScopes(scopes);
  if (role === "operator") {
    return normalized.filter((scope) => scope.startsWith(OPERATOR_SCOPE_PREFIX));
  }
  return normalized.filter((scope) => !scope.startsWith(OPERATOR_SCOPE_PREFIX));
}

/** Summarize token metadata without exposing bearer token strings. */
export function summarizeDeviceTokens(
  tokens: Record<string, DeviceAuthToken> | undefined,
): DeviceAuthTokenSummary[] | undefined {
  if (!tokens) {
    return undefined;
  }
  const summaries = Object.values(tokens)
    .map((token) => ({
      role: token.role,
      scopes: token.scopes,
      createdAtMs: token.createdAtMs,
      rotatedAtMs: token.rotatedAtMs,
      revokedAtMs: token.revokedAtMs,
      lastUsedAtMs: token.lastUsedAtMs,
    }))
    .toSorted((a, b) => a.role.localeCompare(b.role));
  return summaries.length > 0 ? summaries : undefined;
}

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

export function resolveApprovedDeviceScopeBaseline(device: PairedDevice): string[] | null {
  const baseline = device.approvedScopes ?? device.scopes;
  if (!Array.isArray(baseline)) {
    return null;
  }
  return normalizeDeviceAuthScopes(baseline);
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

/** Both recorded-use and frozen-reader authentication consume this same admission decision. */
export function verifyDeviceTokenAgainstDevice(
  device: PairedDevice | null,
  params: {
    token: string;
    role: string;
    scopes: string[];
    requiredSharedGatewaySessionGeneration?: string;
  },
):
  | { ok: false; reason: string }
  | { ok: true; device: PairedDevice; role: string; entry: DeviceAuthToken } {
  if (!device) {
    return { ok: false, reason: "device-not-paired" };
  }
  const role = normalizeOptionalString(params.role);
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
  return { ok: true, device, role, entry };
}
