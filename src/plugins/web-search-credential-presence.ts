// Checks web-search credential presence from config and plugin metadata.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef, normalizeSecretInputString } from "../config/types.secrets.js";
import { normalizePluginId } from "./config-state.js";
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

type WebSearchCredentialPolicy = {
  allowPluginIds: ReadonlySet<string> | undefined;
  allowlistBypassPluginIds: ReadonlySet<string>;
  denyPluginIds: ReadonlySet<string> | undefined;
  disabledPluginIds: ReadonlySet<string>;
  disabledProviderIds: ReadonlySet<string>;
  enabledProviderIds: ReadonlySet<string>;
  pluginsDisabled: boolean;
};

function normalizeProviderId(id: string): string {
  return normalizeOptionalLowercaseString(id) ?? id;
}

function hasConfiguredSearchCredentialCandidate(
  searchConfig: unknown,
  env?: NodeJS.ProcessEnv,
  providerId?: string,
  policy?: WebSearchCredentialPolicy,
): boolean {
  if (!isRecord(searchConfig) || policy?.pluginsDisabled) {
    return false;
  }
  if (
    providerId !== undefined &&
    policy !== undefined &&
    !policy.enabledProviderIds.has(normalizeProviderId(providerId))
  ) {
    return false;
  }
  const allKnownProvidersDisabled =
    policy !== undefined &&
    policy.enabledProviderIds.size === 0 &&
    policy.disabledProviderIds.size > 0;
  const isProviderDisabled = (id: string | undefined) =>
    id !== undefined && policy?.disabledProviderIds.has(normalizeProviderId(id));
  if (
    Object.hasOwn(searchConfig, "apiKey") &&
    (providerId !== undefined || !allKnownProvidersDisabled) &&
    !isProviderDisabled(providerId) &&
    hasConfiguredCredentialValue(searchConfig.apiKey, env)
  ) {
    return true;
  }
  if (providerId) {
    if (isProviderDisabled(providerId)) {
      return false;
    }
    const selectedProviderConfig = searchConfig[providerId];
    return (
      isRecord(selectedProviderConfig) &&
      Object.hasOwn(selectedProviderConfig, "apiKey") &&
      hasConfiguredCredentialValue(selectedProviderConfig.apiKey, env)
    );
  }
  return Object.entries(searchConfig).some(([candidateProviderId, value]) => {
    if (
      policy !== undefined &&
      !policy.enabledProviderIds.has(normalizeProviderId(candidateProviderId))
    ) {
      return false;
    }
    if (isProviderDisabled(candidateProviderId)) {
      return false;
    }
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
  onlyPluginIds?: ReadonlySet<string>,
  policy?: WebSearchCredentialPolicy,
): boolean {
  if (policy?.pluginsDisabled) {
    return false;
  }
  const entries = isRecord(config.plugins?.entries) ? config.plugins.entries : undefined;
  if (!entries) {
    return false;
  }
  return Object.entries(entries).some(([pluginId, entry]) => {
    const normalizedPluginId = normalizePluginId(pluginId);
    if (onlyPluginIds && !onlyPluginIds.has(normalizedPluginId)) {
      return false;
    }
    if (policy && isPluginBlockedByPolicy(policy, normalizedPluginId)) {
      return false;
    }
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
  return normalizeOptionalLowercaseString(searchConfig.provider);
}

type WebSearchCredentialPolicyScope = {
  manifestRecords: readonly PluginManifestRecord[];
  policy: WebSearchCredentialPolicy;
};

function createWebSearchProviderIdSet(records: readonly Pick<PluginManifestRecord, "contracts">[]) {
  return new Set(
    records
      .flatMap((plugin) => plugin.contracts?.webSearchProviders ?? [])
      .map((providerId) => normalizeProviderId(providerId)),
  );
}

function subtractProviderIds(
  allProviderIds: ReadonlySet<string>,
  enabledProviderIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const disabledProviderIds = new Set<string>();
  for (const providerId of allProviderIds) {
    if (!enabledProviderIds.has(providerId)) {
      disabledProviderIds.add(providerId);
    }
  }
  return disabledProviderIds;
}

function createNormalizedPluginIdSet(ids: unknown): ReadonlySet<string> | undefined {
  if (!Array.isArray(ids) || ids.length === 0) {
    return undefined;
  }
  const normalized = new Set(
    ids.map((pluginId) => (typeof pluginId === "string" ? normalizePluginId(pluginId) : "")),
  );
  normalized.delete("");
  return normalized.size > 0 ? normalized : undefined;
}

function createDisabledPluginIdSet(entries: unknown): ReadonlySet<string> {
  if (!isRecord(entries)) {
    return new Set();
  }
  const disabled = new Set<string>();
  for (const [pluginId, entry] of Object.entries(entries)) {
    if (isRecord(entry) && entry.enabled === false) {
      const normalizedPluginId = normalizePluginId(pluginId);
      if (normalizedPluginId) {
        disabled.add(normalizedPluginId);
      }
    }
  }
  return disabled;
}

function isPluginBlockedByPolicy(policy: WebSearchCredentialPolicy, pluginId: string): boolean {
  if (policy.pluginsDisabled) {
    return true;
  }
  if (
    policy.allowPluginIds &&
    !policy.allowlistBypassPluginIds.has(pluginId) &&
    !policy.allowPluginIds.has(pluginId)
  ) {
    return true;
  }
  return policy.denyPluginIds?.has(pluginId) === true || policy.disabledPluginIds.has(pluginId);
}

function createAllowlistBypassPluginIdSet(
  config: OpenClawConfig,
  records: readonly PluginManifestRecord[],
): ReadonlySet<string> {
  if (config.plugins?.bundledDiscovery !== "compat") {
    return new Set();
  }
  return new Set(
    records
      .filter(
        (plugin) =>
          plugin.origin === "bundled" && (plugin.contracts?.webSearchProviders?.length ?? 0) > 0,
      )
      .map((plugin) => plugin.id),
  );
}

function createWebSearchCredentialPolicy(
  config: OpenClawConfig,
  records: readonly PluginManifestRecord[],
): WebSearchCredentialPolicy {
  const policy = {
    allowPluginIds: createNormalizedPluginIdSet(config.plugins?.allow),
    allowlistBypassPluginIds: createAllowlistBypassPluginIdSet(config, records),
    denyPluginIds: createNormalizedPluginIdSet(config.plugins?.deny),
    disabledPluginIds: createDisabledPluginIdSet(config.plugins?.entries),
    disabledProviderIds: new Set<string>(),
    enabledProviderIds: new Set<string>(),
    pluginsDisabled: config.plugins?.enabled === false,
  } satisfies WebSearchCredentialPolicy;
  const allProviderIds = createWebSearchProviderIdSet(records);
  if (policy.pluginsDisabled) {
    return {
      ...policy,
      disabledProviderIds: allProviderIds,
    };
  }
  const enabledRecords = records.filter((plugin) => !isPluginBlockedByPolicy(policy, plugin.id));
  const enabledProviderIds = createWebSearchProviderIdSet(enabledRecords);
  return {
    ...policy,
    disabledProviderIds: subtractProviderIds(allProviderIds, enabledProviderIds),
    enabledProviderIds,
  };
}

function resolvePolicyFilteredWebSearchScope(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  origin?: PluginManifestRecord["origin"];
}): WebSearchCredentialPolicyScope {
  const allManifestRecords = loadManifestMetadataSnapshot({
    config: params.config,
    env: params.env ?? {},
  }).plugins.filter((plugin) => (plugin.contracts?.webSearchProviders?.length ?? 0) > 0);
  const policy = createWebSearchCredentialPolicy(params.config, allManifestRecords);
  if (policy.pluginsDisabled) {
    return {
      manifestRecords: [],
      policy,
    };
  }
  const manifestRecords = allManifestRecords.filter(
    (plugin) =>
      (!params.origin || plugin.origin === params.origin) &&
      !isPluginBlockedByPolicy(policy, plugin.id),
  );
  return {
    manifestRecords,
    policy,
  };
}

function resolveExplicitProviderPluginIds(params: {
  manifestRecords: readonly PluginManifestRecord[];
  providerId: string | undefined;
}): ReadonlySet<string> | undefined {
  const providerId = params.providerId;
  if (!providerId) {
    return undefined;
  }
  const pluginIds = params.manifestRecords
    .filter((plugin) => (plugin.contracts?.webSearchProviders ?? []).includes(providerId))
    .map((plugin) => plugin.id);
  return new Set(pluginIds);
}

function hasExplicitKeylessProviderCandidate(params: {
  manifestRecords: readonly PluginManifestRecord[];
  searchConfig: unknown;
}): boolean {
  const providerId = getConfiguredProviderId(params.searchConfig);
  if (!providerId) {
    return false;
  }
  const manifestRecords = params.manifestRecords.filter((plugin) =>
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

function resolveBundledProviderContractEnvVars(params: {
  manifestRecords: readonly PluginManifestRecord[];
  providerId: string | undefined;
}): readonly string[] | undefined {
  if (!params.providerId || params.manifestRecords.length === 0) {
    return undefined;
  }
  try {
    const providers = resolveBundledExplicitWebSearchProvidersFromPublicArtifacts({
      onlyPluginIds: params.manifestRecords.map((plugin) => plugin.id),
    });
    const envVars = providers
      ?.filter((provider) => provider.id === params.providerId)
      ?.flatMap((provider) => provider.envVars ?? []);
    return envVars && envVars.length > 0 ? envVars : undefined;
  } catch {
    return undefined;
  }
}

function resolveManifestEnvVarsForProvider(
  plugin: PluginManifestRecord,
  providerId: string | undefined,
): readonly string[] {
  if (!providerId) {
    return [
      ...(plugin.setup?.providers ?? []).flatMap((provider) => provider.envVars ?? []),
      ...Object.values(plugin.providerAuthEnvVars ?? {}).flat(),
    ];
  }
  return [
    ...(plugin.setup?.providers ?? [])
      .filter((provider) => provider.id === providerId)
      .flatMap((provider) => provider.envVars ?? []),
    ...(plugin.providerAuthEnvVars?.[providerId] ?? []),
  ];
}

function hasManifestWebSearchEnvCredentialCandidate(params: {
  manifestRecords: readonly PluginManifestRecord[];
  env?: NodeJS.ProcessEnv;
  providerId?: string;
}): boolean {
  const env = params.env;
  if (!env) {
    return false;
  }
  if (!Object.values(env).some(hasConfiguredLiteralCredentialValue)) {
    return false;
  }
  const providerContractEnvVars = resolveBundledProviderContractEnvVars({
    manifestRecords: params.manifestRecords,
    providerId: params.providerId,
  });
  if (providerContractEnvVars) {
    return providerContractEnvVars.some((envVar) =>
      hasConfiguredLiteralCredentialValue(env[envVar]),
    );
  }
  return params.manifestRecords.some((plugin) => {
    if (
      params.providerId &&
      !(plugin.contracts?.webSearchProviders ?? []).includes(params.providerId)
    ) {
      return false;
    }
    if ((plugin.contracts?.webSearchProviders?.length ?? 0) === 0) {
      return false;
    }
    const envVars = resolveManifestEnvVarsForProvider(plugin, params.providerId);
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
  const providerId = getConfiguredProviderId(searchConfig);
  const policyScope = resolvePolicyFilteredWebSearchScope({
    config: params.config,
    env: params.env,
    origin: params.origin,
  });
  const explicitProviderPluginIds = resolveExplicitProviderPluginIds({
    manifestRecords: policyScope.manifestRecords,
    providerId,
  });
  return (
    hasConfiguredSearchCredentialCandidate(
      searchConfig,
      params.env,
      providerId,
      policyScope.policy,
    ) ||
    hasConfiguredPluginWebSearchCandidate(
      params.config,
      params.env,
      explicitProviderPluginIds,
      policyScope.policy,
    ) ||
    hasExplicitKeylessProviderCandidate({
      manifestRecords: policyScope.manifestRecords,
      searchConfig,
    }) ||
    hasManifestWebSearchEnvCredentialCandidate({
      manifestRecords: policyScope.manifestRecords,
      env: params.env,
      providerId,
    })
  );
}
