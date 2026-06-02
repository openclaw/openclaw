import { resolveBundledPluginCompatibleLoadValues } from "./activation-context.js";
import type { PluginLoadOptions } from "./loader.js";
import { loadManifestMetadataSnapshot } from "./manifest-contract-eligibility.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { createPluginIdScopeSet, normalizePluginIdScope } from "./plugin-scope.js";

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

/** Sorts provider entries deterministically for CLI output and prompt payloads. */
export function sortPluginProviders<T extends Pick<WebProviderSortEntry, "id" | "pluginId">>(
  providers: T[],
): T[] {
  return providers.toSorted(comparePluginProvidersAlphabetically);
}

/**
 * Sorts provider entries for auto-detection.
 *
 * Manifest order wins when present; alphabetical fallback keeps equivalent
 * providers stable across registry and filesystem enumeration order.
 */
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
  // Older manifests exposed web provider config before declaring the formal
  // contract. Treat config UI/schema ownership as declaration evidence so those
  // plugins still participate in provider setup and discovery.
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
  const records = loadManifestMetadataSnapshot({
    config: params.config ?? {},
    workspaceDir: params.workspaceDir,
    env: params.env ?? process.env,
  }).plugins;
  const pluginIdSet = createPluginIdScopeSet(params.pluginIds);
  return pluginIdSet ? records.filter((plugin) => pluginIdSet.has(plugin.id)) : records;
}

/**
 * Resolves plugin ids whose manifests can provide the requested web-provider contract.
 *
 * Returns `undefined` when an unconstrained scan found no declaration so callers
 * can fall back to runtime discovery; explicit scopes return an empty list.
 */
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

/**
 * Resolves manifest web-provider candidates plus the snapshot used for the scan.
 *
 * The returned snapshot lets callers reuse manifest metadata after deciding
 * whether runtime provider loading is necessary.
 */
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
}): {
  config: PluginLoadOptions["config"];
  activationSourceConfig?: PluginLoadOptions["config"];
  autoEnabledReasons: Record<string, string[]>;
} {
  // Bundled web providers predate manifest-only discovery. Resolve the compat
  // activation config here so legacy bundled providers are auto-enabled before
  // provider enumeration without teaching callers plugin-specific defaults.
  const activation = resolveBundledPluginCompatibleLoadValues({
    rawConfig: params.config,
    env: params.env,
    workspaceDir: params.workspaceDir,
    applyAutoEnable: true,
    compatMode: {
      enablement: "always",
      vitest: params.config !== undefined,
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
 * Maps registry provider entries into the public provider shape.
 *
 * The `pluginId` is attached after filtering so later selection logic can trace
 * provider ids back to the owning plugin without re-reading the registry.
 */
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
