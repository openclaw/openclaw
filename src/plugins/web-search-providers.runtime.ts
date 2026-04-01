import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isRecord } from "../utils.js";
import {
  buildPluginSnapshotCacheEnvKey,
  resolvePluginSnapshotCacheTtlMs,
  shouldUsePluginSnapshotCache,
} from "./cache-controls.js";
import { loadOpenClawPlugins, resolveRuntimePluginRegistry } from "./loader.js";
import type { PluginLoadOptions } from "./loader.js";
import { createPluginLoaderLogger } from "./logger.js";
import { loadPluginManifestRegistry, type PluginManifestRecord } from "./manifest-registry.js";
import type { PluginWebSearchProviderEntry } from "./types.js";
import {
  resolveBundledWebSearchResolutionConfig,
  sortWebSearchProviders,
} from "./web-search-providers.shared.js";

const log = createSubsystemLogger("plugins");
type WebSearchProviderSnapshotCacheEntry = {
  expiresAt: number;
  providers: PluginWebSearchProviderEntry[];
};
let webSearchProviderSnapshotCache = new WeakMap<
  OpenClawConfig,
  WeakMap<NodeJS.ProcessEnv, Map<string, WebSearchProviderSnapshotCacheEntry>>
>();

function resetWebSearchProviderSnapshotCacheForTests() {
  webSearchProviderSnapshotCache = new WeakMap<
    OpenClawConfig,
    WeakMap<NodeJS.ProcessEnv, Map<string, WebSearchProviderSnapshotCacheEntry>>
  >();
}

export const __testing = {
  resetWebSearchProviderSnapshotCacheForTests,
} as const;
function buildWebSearchSnapshotCacheKey(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  bundledAllowlistCompat?: boolean;
  onlyPluginIds?: readonly string[];
  env: NodeJS.ProcessEnv;
}): string {
  return JSON.stringify({
    workspaceDir: params.workspaceDir ?? "",
    bundledAllowlistCompat: params.bundledAllowlistCompat === true,
    onlyPluginIds: [...new Set(params.onlyPluginIds ?? [])].toSorted((left, right) =>
      left.localeCompare(right),
    ),
    config: params.config ?? null,
    env: buildPluginSnapshotCacheEnvKey(params.env),
  });
}

function pluginManifestDeclaresWebSearch(record: PluginManifestRecord): boolean {
  if ((record.contracts?.webSearchProviders?.length ?? 0) > 0) {
    return true;
  }
  const configUiHintKeys = Object.keys(record.configUiHints ?? {});
  if (configUiHintKeys.some((key) => key === "webSearch" || key.startsWith("webSearch."))) {
    return true;
  }
  if (!isRecord(record.configSchema)) {
    return false;
  }
  const properties = record.configSchema.properties;
  return isRecord(properties) && "webSearch" in properties;
}

function resolveWebSearchCandidatePluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds?: readonly string[];
}): string[] | undefined {
  const registry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const onlyPluginIdSet =
    params.onlyPluginIds && params.onlyPluginIds.length > 0 ? new Set(params.onlyPluginIds) : null;
  const ids = registry.plugins
    .filter(
      (plugin) =>
        pluginManifestDeclaresWebSearch(plugin) &&
        (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.id)),
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
  return ids.length > 0 ? ids : undefined;
}

function resolveWebSearchLoadOptions(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
  onlyPluginIds?: readonly string[];
  activate?: boolean;
  cache?: boolean;
}) {
  const env = params.env ?? process.env;
  const { config } = resolveBundledWebSearchResolutionConfig({
    ...params,
    env,
  });
  const onlyPluginIds = resolveWebSearchCandidatePluginIds({
    config,
    workspaceDir: params.workspaceDir,
    env,
    onlyPluginIds: params.onlyPluginIds,
  });
  return {
    env,
    config,
    workspaceDir: params.workspaceDir,
    cache: params.cache ?? false,
    activate: params.activate ?? false,
    ...(onlyPluginIds ? { onlyPluginIds } : {}),
    logger: createPluginLoaderLogger(log),
  } satisfies PluginLoadOptions;
}

function mapRegistryWebSearchProviders(params: {
  registry: ReturnType<typeof loadOpenClawPlugins>;
  onlyPluginIds?: readonly string[];
}): PluginWebSearchProviderEntry[] {
  const onlyPluginIdSet =
    params.onlyPluginIds && params.onlyPluginIds.length > 0 ? new Set(params.onlyPluginIds) : null;
  return sortWebSearchProviders(
    params.registry.webSearchProviders
      .filter((entry) => !onlyPluginIdSet || onlyPluginIdSet.has(entry.pluginId))
      .map((entry) => ({
        ...entry.provider,
        pluginId: entry.pluginId,
      })),
  );
}

export function resolvePluginWebSearchProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
  onlyPluginIds?: readonly string[];
  activate?: boolean;
  cache?: boolean;
}): PluginWebSearchProviderEntry[] {
  const env = params.env ?? process.env;
  const cacheOwnerConfig = params.config;
  const shouldMemoizeSnapshot =
    params.activate !== true && params.cache !== true && shouldUsePluginSnapshotCache(env);
  const cacheKey = buildWebSearchSnapshotCacheKey({
    config: cacheOwnerConfig,
    workspaceDir: params.workspaceDir,
    bundledAllowlistCompat: params.bundledAllowlistCompat,
    onlyPluginIds: params.onlyPluginIds,
    env,
  });
  if (cacheOwnerConfig && shouldMemoizeSnapshot) {
    const configCache = webSearchProviderSnapshotCache.get(cacheOwnerConfig);
    const envCache = configCache?.get(env);
    const cached = envCache?.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.providers;
    }
  }
  const loadOptions = resolveWebSearchLoadOptions(params);
  const resolved = mapRegistryWebSearchProviders({
    registry: loadOpenClawPlugins(loadOptions),
  });
  if (cacheOwnerConfig && shouldMemoizeSnapshot) {
    const ttlMs = resolvePluginSnapshotCacheTtlMs(env);
    let configCache = webSearchProviderSnapshotCache.get(cacheOwnerConfig);
    if (!configCache) {
      configCache = new WeakMap<
        NodeJS.ProcessEnv,
        Map<string, WebSearchProviderSnapshotCacheEntry>
      >();
      webSearchProviderSnapshotCache.set(cacheOwnerConfig, configCache);
    }
    let envCache = configCache.get(env);
    if (!envCache) {
      envCache = new Map<string, WebSearchProviderSnapshotCacheEntry>();
      configCache.set(env, envCache);
    }
    envCache.set(cacheKey, {
      expiresAt: Date.now() + ttlMs,
      providers: resolved,
    });
  }
  return resolved;
}

export function resolveRuntimeWebSearchProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
  onlyPluginIds?: readonly string[];
}): PluginWebSearchProviderEntry[] {
  const runtimeRegistry = resolveRuntimePluginRegistry(
    params.config === undefined ? undefined : resolveWebSearchLoadOptions(params),
  );
  if (runtimeRegistry) {
    return mapRegistryWebSearchProviders({
      registry: runtimeRegistry,
      onlyPluginIds: params.onlyPluginIds,
    });
  }
  return resolvePluginWebSearchProviders(params);
}
