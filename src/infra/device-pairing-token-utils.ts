import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import type { DeviceAuthToken } from "./device-pairing.types.js";
import { generatePairingToken } from "./pairing-token.js";

const OPERATOR_SCOPE_PREFIX = "operator.";

/** Redacted token metadata safe for list/status responses. */
export type DeviceAuthTokenSummary = {
  role: string;
  scopes: string[];
  createdAtMs: number;
  rotatedAtMs?: number;
  revokedAtMs?: number;
  lastUsedAtMs?: number;
};

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
