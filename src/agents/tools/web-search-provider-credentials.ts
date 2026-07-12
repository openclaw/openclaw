/**
 * Web-search provider credential resolver.
 *
 * Reads config values, env-backed secret refs, and provider-specific environment variables.
 */
import type { SecretRef } from "../../config/types.secrets.js";
import { resolveSecretInputString } from "../../config/types.secrets.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";

type SecretDefaults = {
  env?: string;
  file?: string;
  exec?: string;
};

type CredentialEnv = Record<string, string | undefined>;

type WebSearchProviderCredentialResolverParams = {
  credentialValue: unknown;
  path: string;
  envVars: readonly string[];
  defaults?: SecretDefaults;
  env?: CredentialEnv;
  normalizeCredential?: (value: unknown) => string | undefined;
  onUnavailableConfiguredRef?: (ref: SecretRef) => void;
};

function defaultNormalizeCredential(value: unknown): string | undefined {
  return normalizeSecretInput(value) || undefined;
}

function normalizeCredential(
  params: WebSearchProviderCredentialResolverParams,
  value: unknown,
): string | undefined {
  return (params.normalizeCredential ?? defaultNormalizeCredential)(value);
}

/**
 * Resolves web-search provider credentials from config values, secret refs, or
 * provider-specific environment variables.
 */
/** Returns the first usable credential for a web-search provider. */
export function resolveWebSearchProviderCredential(
  params: WebSearchProviderCredentialResolverParams,
): string | undefined {
  const resolved = resolveSecretInputString({
    value: params.credentialValue,
    defaults: params.defaults,
    path: params.path,
    mode: "inspect",
  });
  if (resolved.status === "available") {
    const credential = normalizeCredential(params, resolved.value);
    if (credential) {
      return credential;
    }
  } else if (resolved.status === "configured_unavailable") {
    if (resolved.ref.source === "env") {
      const envCredential = normalizeCredential(
        params,
        (params.env ?? process.env)[resolved.ref.id],
      );
      if (envCredential) {
        return envCredential;
      }
    }
    params.onUnavailableConfiguredRef?.(resolved.ref);
    return undefined;
  }

  const env = params.env ?? process.env;
  for (const envVar of params.envVars) {
    const credential = normalizeCredential(params, env[envVar]);
    if (credential) {
      return credential;
    }
  }

  return undefined;
}
