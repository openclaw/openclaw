import { resolveBundledPluginCompatibleLoadValues } from "./activation-context.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import type { PluginLoadOptions } from "./loader.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";
import {
  createPluginIdScopeSet,
  normalizePluginIdScope,
  serializePluginIdScope,
} from "./plugin-scope.js";

export type WebProviderContract = "webSearchProviders" | "webFetchProviders";
export type WebProviderConfigKey = "webSearch" | "webFetch";

export type WebProviderCandidateResolution = {
  pluginIds: string[] | undefined;
  manifestRecords?: readonly PluginManifestRecord[];
};

type WebProviderSortEntry = {
  id: string;
  pluginId: string;
  autoDetectOrder?: number;
};

function comparePluginProvidersAlphabetically(
  left: Pick<WebProviderSortEntry, "id" | "pluginId">,
  right: Pick<WebProviderSortEntry, "id" | "pluginId">,
): number {
  return left.id.localeCompare(right.id) || left.pluginId.localeCompare(right.pluginId);
}

export function sortPluginProviders<T extends Pick<WebProviderSortEntry, "id" | "pluginId">>(
  providers: T[],
): T[] {
  return providers.toSorted(comparePluginProvidersAlphabetically);
}

export function sortPluginProvidersForAutoDetect<T extends WebProviderSortEntry>(
  providers: T[],
): T[] {
  return providers.toSorted((left, right) => {
    const leftOrder = left.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return comparePluginProvidersAlphabetically(left, right);
  });
}

function pluginManifestDeclaresProviderConfig(
  record: PluginManifestRecord,
  configKey: WebProviderConfigKey,
  contract: WebProviderContract,
): boolean {
  if ((record.contracts?.[contract]?.length ?? 0) > 0) {
    return true;
  }
  const configUiHintKeys = Object.keys(record.configUiHints ?? {});
  if (configUiHintKeys.some((key) => key === configKey || key.startsWith(`${configKey}.`))) {
    return true;
  }
  const properties = record.configSchema?.properties;
  return typeof properties === "object" && properties !== null && configKey in properties;
}

function loadInstalledWebProviderManifestRecords(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  pluginIds?: readonly string[];
}): readonly PluginManifestRecord[] {
  return loadPluginManifestRegistryForPluginRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    pluginIds: params.pluginIds,
    includeDisabled: true,
  }).plugins;
}

export function resolveManifestDeclaredWebProviderCandidatePluginIds(params: {
  contract: WebProviderContract;
  configKey: WebProviderConfigKey;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds?: readonly string[];
  origin?: PluginManifestRecord["origin"];
}): string[] | undefined {
  return resolveManifestDeclaredWebProviderCandidates(params).pluginIds;
}

export function resolveManifestDeclaredWebProviderCandidates(params: {
  contract: WebProviderContract;
  configKey: WebProviderConfigKey;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds?: readonly string[];
  origin?: PluginManifestRecord["origin"];
  manifestRecords?: readonly PluginManifestRecord[];
}): WebProviderCandidateResolution {
  const scopedPluginIds = normalizePluginIdScope(params.onlyPluginIds);
  if (scopedPluginIds?.length === 0) {
    return { pluginIds: [] };
  }
  const onlyPluginIdSet = createPluginIdScopeSet(scopedPluginIds);
  const manifestRecords =
    params.manifestRecords ??
    loadInstalledWebProviderManifestRecords({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      pluginIds: scopedPluginIds,
    });
  const ids = manifestRecords
    .filter(
      (plugin) =>
        (!params.origin || plugin.origin === params.origin) &&
        (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.id)) &&
        pluginManifestDeclaresProviderConfig(plugin, params.configKey, params.contract),
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
  if (ids.length > 0) {
    return { pluginIds: ids, manifestRecords };
  }
  if (params.origin || scopedPluginIds !== undefined) {
    return { pluginIds: [], manifestRecords };
  }
  return { pluginIds: undefined, manifestRecords };
}

function resolveBundledWebProviderCompatPluginIds(params: {
  contract: WebProviderContract;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  return loadInstalledWebProviderManifestRecords(params)
    .filter(
      (plugin) =>
        plugin.origin === "bundled" && (plugin.contracts?.[params.contract]?.length ?? 0) > 0,
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function resolveBundledWebProviderResolutionConfig(params: {
  contract: WebProviderContract;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
}): {
  config: PluginLoadOptions["config"];
  activationSourceConfig?: PluginLoadOptions["config"];
  autoEnabledReasons: Record<string, string[]>;
} {
  const activation = resolveBundledPluginCompatibleLoadValues({
    rawConfig: params.config,
    env: params.env,
    workspaceDir: params.workspaceDir,
    applyAutoEnable: true,
    compatMode: {
      allowlist: params.bundledAllowlistCompat,
      enablement: "always",
      vitest: true,
    },
    resolveCompatPluginIds: (compatParams) =>
      resolveBundledWebProviderCompatPluginIds({
        contract: params.contract,
        ...compatParams,
      }),
  });

  return {
    config: activation.config,
    activationSourceConfig: activation.activationSourceConfig,
    autoEnabledReasons: activation.autoEnabledReasons,
  };
}

/**
 * Per-process content fingerprint cache for web-provider resolution. Memoizes
 * the config-content hash by object identity so callers that share an
 * `OpenClawConfig` reference pay the hash cost only once. Callers that build
 * a fresh config object per dispatch (the original #73730 pattern) still pay
 * one hash per call but produce the same cache key as long as the
 * resolution-relevant fields stay the same.
 */
const webProviderConfigFingerprintCache = new WeakMap<object, string>();

/**
 * Stable hash of the `OpenClawConfig` subset that affects which web providers
 * resolve. Currently `plugins.entries` (enabled state, allowlist, per-plugin
 * config) is the only field consumed by `loadPluginManifestRegistryForPluginRegistry`
 * and the bundled-runtime resolution path. Returns "" when no config is
 * supplied so the JSON.stringify cache key stays stable for both shapes.
 */
export function fingerprintWebProviderResolutionConfig(
  config?: PluginLoadOptions["config"],
): string {
  if (!config) {
    return "";
  }
  const cached = webProviderConfigFingerprintCache.get(config as unknown as object);
  if (cached !== undefined) {
    return cached;
  }
  const subset = {
    plugins: (config as { plugins?: unknown }).plugins ?? null,
  };
  const hash = hashJson(subset);
  webProviderConfigFingerprintCache.set(config as unknown as object, hash);
  return hash;
}

export function buildWebProviderSnapshotCacheKey(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  bundledAllowlistCompat?: boolean;
  onlyPluginIds?: readonly string[];
  origin?: PluginManifestRecord["origin"];
  envKey: string | Record<string, string>;
}): string {
  const envKey =
    typeof params.envKey === "string"
      ? params.envKey
      : Object.entries(params.envKey).toSorted(([left], [right]) => left.localeCompare(right));
  const onlyPluginIds = normalizePluginIdScope(params.onlyPluginIds);
  return JSON.stringify({
    workspaceDir: params.workspaceDir ?? "",
    bundledAllowlistCompat: params.bundledAllowlistCompat === true,
    origin: params.origin ?? "",
    onlyPluginIds: serializePluginIdScope(onlyPluginIds),
    env: envKey,
    configFingerprint: fingerprintWebProviderResolutionConfig(params.config),
  });
}

export function mapRegistryProviders<TProvider extends { id: string }>(params: {
  entries: readonly { pluginId: string; provider: TProvider }[];
  onlyPluginIds?: readonly string[];
  sortProviders: (
    providers: Array<TProvider & { pluginId: string }>,
  ) => Array<TProvider & { pluginId: string }>;
}): Array<TProvider & { pluginId: string }> {
  const onlyPluginIdSet = createPluginIdScopeSet(normalizePluginIdScope(params.onlyPluginIds));
  return params.sortProviders(
    params.entries
      .filter((entry) => !onlyPluginIdSet || onlyPluginIdSet.has(entry.pluginId))
      .map((entry) => Object.assign({}, entry.provider, { pluginId: entry.pluginId })),
  );
}
