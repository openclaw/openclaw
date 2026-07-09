// Checks web-search credential presence from config and plugin metadata.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef, normalizeSecretInputString } from "../config/types.secrets.js";
import { loadManifestMetadataSnapshot } from "./manifest-contract-eligibility.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { resolveBundledExplicitWebSearchProvidersFromPublicArtifacts } from "./web-provider-public-artifacts.explicit.js";

function hasConfiguredCredentialValue(value: unknown, env?: NodeJS.ProcessEnv): boolean {
  const ref = coerceSecretRef(value);
  if (ref?.source === "env") {
    return hasConfiguredLiteralCredentialValue(env?.[ref.id]);
  }
  if (ref) {
    return true;
  }
  return hasConfiguredLiteralCredentialValue(value);
}

function hasConfiguredLiteralCredentialValue(value: unknown): boolean {
  return normalizeSecretInputString(value) !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasConfiguredSearchCredentialCandidate(
  searchConfig: unknown,
  env?: NodeJS.ProcessEnv,
): boolean {
  if (!isRecord(searchConfig)) {
    return false;
  }
  if (
    Object.hasOwn(searchConfig, "apiKey") &&
    hasConfiguredCredentialValue(searchConfig.apiKey, env)
  ) {
    return true;
  }
  return Object.values(searchConfig).some((value) => {
    if (!isRecord(value) || !Object.hasOwn(value, "apiKey")) {
      return false;
    }
    return hasConfiguredCredentialValue(value.apiKey, env);
  });
}

function hasConfiguredPluginSearchCredentialCandidate(
  searchConfig: unknown,
  env?: NodeJS.ProcessEnv,
): boolean {
  if (!isRecord(searchConfig)) {
    return false;
  }
  if (hasConfiguredSearchCredentialCandidate(searchConfig, env)) {
    return true;
  }
  return (
    Object.hasOwn(searchConfig, "baseUrl") &&
    hasConfiguredCredentialValue(searchConfig.baseUrl, env)
  );
}

function hasConfiguredPluginWebSearchCandidate(
  config: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): boolean {
  const entries = isRecord(config.plugins?.entries) ? config.plugins.entries : undefined;
  if (!entries) {
    return false;
  }
  return Object.values(entries).some((entry) => {
    const pluginConfig = isRecord(entry) ? entry.config : undefined;
    return (
      isRecord(pluginConfig) &&
      hasConfiguredPluginSearchCredentialCandidate(pluginConfig.webSearch, env)
    );
  });
}

function getConfiguredProviderId(searchConfig: unknown): string | undefined {
  if (!isRecord(searchConfig)) {
    return undefined;
  }
  return normalizeOptionalString(searchConfig.provider);
}

function hasExplicitKeylessProviderCandidate(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  searchConfig: unknown;
  origin?: PluginManifestRecord["origin"];
}): boolean {
  const providerId = getConfiguredProviderId(params.searchConfig);
  if (!providerId) {
    return false;
  }
  const manifestRecords = loadManifestMetadataSnapshot({
    config: params.config,
    env: params.env ?? {},
  }).plugins.filter(
    (plugin) =>
      (!params.origin || plugin.origin === params.origin) &&
      (plugin.contracts?.webSearchProviders ?? []).includes(providerId),
  );
  if (manifestRecords.length === 0) {
    return false;
  }
  try {
    const providers = resolveBundledExplicitWebSearchProvidersFromPublicArtifacts({
      onlyPluginIds: manifestRecords.map((plugin) => plugin.id),
    });
    return (
      providers?.some(
        (provider) => provider.id === providerId && provider.requiresCredential === false,
      ) ?? false
    );
  } catch {
    return false;
  }
}

function hasManifestWebSearchEnvCredentialCandidate(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  origin?: PluginManifestRecord["origin"];
}): boolean {
  const env = params.env;
  if (!env) {
    return false;
  }
  return loadManifestMetadataSnapshot({
    config: params.config,
    env,
  }).plugins.some((plugin) => {
    if (params.origin && plugin.origin !== params.origin) {
      return false;
    }
    if ((plugin.contracts?.webSearchProviders?.length ?? 0) === 0) {
      return false;
    }
    const envVars = [
      ...(plugin.setup?.providers ?? []).flatMap((provider) => provider.envVars ?? []),
      ...Object.values(plugin.providerAuthEnvVars ?? {}).flat(),
    ];
    return envVars.some((envVar) => hasConfiguredLiteralCredentialValue(env[envVar]));
  });
}

export function hasConfiguredWebSearchCredential(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  searchConfig?: Record<string, unknown>;
  origin?: PluginManifestRecord["origin"];
}): boolean {
  const searchConfig =
    params.searchConfig ??
    (params.config.tools?.web?.search as Record<string, unknown> | undefined);
  return (
    hasConfiguredSearchCredentialCandidate(searchConfig, params.env) ||
    hasConfiguredPluginWebSearchCandidate(params.config, params.env) ||
    hasExplicitKeylessProviderCandidate({
      config: params.config,
      env: params.env,
      searchConfig,
      origin: params.origin,
    }) ||
    hasManifestWebSearchEnvCredentialCandidate({
      config: params.config,
      env: params.env,
      origin: params.origin,
    })
  );
}
