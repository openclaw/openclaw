/** Local credential values for discovery, without profile or transport loading. */
import type { SecretRefSource } from "../config/types.secrets.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";

/** Marker for a secret-ref-managed credential that is not stored as an env var. */
export const NON_ENV_SECRETREF_MARKER = "secretref-managed"; // pragma: allowlist secret

/** Resolve the API-key placeholder for a non-env secret-ref source. */
export function resolveNonEnvSecretRefApiKeyMarker(_source: SecretRefSource): string {
  return NON_ENV_SECRETREF_MARKER;
}

export function readProviderEnvValue(envVars: string[]): string | undefined {
  for (const envVar of envVars) {
    const value = normalizeSecretInput(process.env[envVar]);
    if (value) {
      return value;
    }
  }
  return undefined;
}
