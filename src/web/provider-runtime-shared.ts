import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef, isLegacySecretRefEnvMarker } from "../config/types.secrets.js";
import type { PluginWebSearchProviderEntry } from "../plugins/web-provider-types.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import { readParsedField } from "../utils/string-readers.js";

type WebProviderConfigSource = {
  tools?: {
    web?: {
      search?: unknown;
      fetch?: unknown;
    };
  };
};

export type WebProviderWithCredential = Pick<
  PluginWebSearchProviderEntry,
  | "envVars"
  | "authProviderId"
  | "requiresCredential"
  | "getConfiguredCredentialValue"
  | "getConfiguredCredentialFallback"
>;

export function resolveWebProviderConfig(
  cfg: WebProviderConfigSource | undefined,
  kind: "search" | "fetch",
): Record<string, unknown> | undefined {
  return asOptionalObjectRecord(cfg?.tools?.web?.[kind]);
}

export function readWebProviderEnvValue(
  envVars: string[],
  processEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return readParsedField(processEnv, envVars, normalizeOptionalSecretInput);
}

export function providerRequiresCredential(
  provider: Pick<WebProviderWithCredential, "requiresCredential">,
): boolean {
  return provider.requiresCredential !== false;
}

export function hasWebProviderEntryCredential(params: {
  provider: WebProviderWithCredential;
  config?: OpenClawConfig;
  resolveEnvValue: (configuredEnvVarId?: string) => string | undefined;
  resolveProviderAuthValue?: (providerId: string) => boolean;
}): boolean {
  if (!providerRequiresCredential(params.provider)) {
    return true;
  }
  const rawValue = params.provider.getConfiguredCredentialValue?.(params.config);
  if (isLegacySecretRefEnvMarker(rawValue)) {
    return false;
  }
  const configuredRef = coerceSecretRef(rawValue);
  if (configuredRef && configuredRef.source !== "env") {
    return true;
  }
  const fromConfig = configuredRef ? "" : normalizeOptionalSecretInput(rawValue);
  if (fromConfig) {
    return true;
  }
  if (
    params.provider.authProviderId &&
    params.resolveProviderAuthValue?.(params.provider.authProviderId)
  ) {
    return true;
  }
  if (params.resolveEnvValue(configuredRef?.source === "env" ? configuredRef.id : undefined)) {
    return true;
  }
  const fallbackRawValue = params.provider.getConfiguredCredentialFallback?.(params.config)?.value;
  if (isLegacySecretRefEnvMarker(fallbackRawValue)) {
    return false;
  }
  const fallbackRef = coerceSecretRef(fallbackRawValue);
  if (fallbackRef && fallbackRef.source !== "env") {
    return true;
  }
  const fallbackConfig = fallbackRef ? "" : normalizeOptionalSecretInput(fallbackRawValue);
  if (fallbackConfig) {
    return true;
  }
  return Boolean(
    fallbackRef?.source === "env" ? params.resolveEnvValue(fallbackRef.id) : undefined,
  );
}
