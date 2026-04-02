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
import type { PluginWebFetchProviderEntry } from "./types.js";
import {
  resolveBundledWebFetchResolutionConfig,
  sortWebFetchProviders,
} from "./web-fetch-providers.shared.js";

const log = createSubsystemLogger("plugins");
type WebFetchProviderSnapshotCacheEntry = {
  expiresAt: number;
  providers: PluginWebFetchProviderEntry[];
};
let webFetchProviderSnapshotCache = new WeakMap<
  OpenClawConfig,
  WeakMap<NodeJS.ProcessEnv, Map<string, WebFetchProviderSnapshotCacheEntry>>
>();

function resetWebFetchProviderSnapshotCacheForTests() {
  webFetchProviderSnapshotCache = new WeakMap<
    OpenClawConfig,
    WeakMap<NodeJS.ProcessEnv, Map<string, WebFetchProviderSnapshotCacheEntry>>
  >();
}

export const __testing = {
  resetWebFetchProviderSnapshotCacheForTests,
} as const;

function buildWebFetchSnapshotCacheKey(params: {
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

function pluginManifestDeclaresWebFetch(record: PluginManifestRecord): boolean {
  if ((record.contracts?.webFetchProviders?.length ?? 0) > 0) {
    return true;
  }
  const configUiHintKeys = Object.keys(record.configUiHints ?? {});
  if (configUiHintKeys.some((key) => key === "webFetch" || key.startsWith("webFetch."))) {
    return true;
  }
  if (!isRecord(record.configSchema)) {
    return false;
  }
  const properties = record.configSchema.properties;
  return isRecord(properties) && "webFetch" in properties;
}

function resolveWebFetchCandidatePluginIds(params: {
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
        pluginManifestDeclaresWebFetch(plugin) &&
        (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.id)),
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
  return ids.length > 0 ? ids : undefined;
}

function resolveWebFetchLoadOptions(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
  onlyPluginIds?: readonly string[];
  activate?: boolean;
  cache?: boolean;
}) {
  const env = params.env ?? process.env;
  const { config } = resolveBundledWebFetchResolutionConfig({
    ...params,
    env,
  });
  const onlyPluginIds = resolveWebFetchCandidatePluginIds({
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

function mapRegistryWebFetchProviders(params: {
  registry: ReturnType<typeof loadOpenClawPlugins>;
  onlyPluginIds?: readonly string[];
}): PluginWebFetchProviderEntry[] {
  const onlyPluginIdSet =
    params.onlyPluginIds && params.onlyPluginIds.length > 0 ? new Set(params.onlyPluginIds) : null;
  return sortWebFetchProviders(
    params.registry.webFetchProviders
      .filter((entry) => !onlyPluginIdSet || onlyPluginIdSet.has(entry.pluginId))
      .map((entry) => ({
        ...entry.provider,
        pluginId: entry.pluginId,
      })),
  );
}

export function resolvePluginWebFetchProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
  onlyPluginIds?: readonly string[];
  activate?: boolean;
  cache?: boolean;
}): PluginWebFetchProviderEntry[] {
  const env = params.env ?? process.env;
  const cacheOwnerConfig = params.config;
  const shouldMemoizeSnapshot =
    params.activate !== true && params.cache !== true && shouldUsePluginSnapshotCache(env);
  const cacheKey = buildWebFetchSnapshotCacheKey({
    config: cacheOwnerConfig,
    workspaceDir: params.workspaceDir,
    bundledAllowlistCompat: params.bundledAllowlistCompat,
    onlyPluginIds: params.onlyPluginIds,
    env,
  });
  if (cacheOwnerConfig && shouldMemoizeSnapshot) {
    const configCache = webFetchProviderSnapshotCache.get(cacheOwnerConfig);
    const envCache = configCache?.get(env);
    const cached = envCache?.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.providers;
    }
  }
  const loadOptions = resolveWebFetchLoadOptions(params);
  const resolved = mapRegistryWebFetchProviders({
    registry: loadOpenClawPlugins(loadOptions),
  });
  if (cacheOwnerConfig && shouldMemoizeSnapshot) {
    const ttlMs = resolvePluginSnapshotCacheTtlMs(env);
    let configCache = webFetchProviderSnapshotCache.get(cacheOwnerConfig);
    if (!configCache) {
      configCache = new WeakMap<
        NodeJS.ProcessEnv,
        Map<string, WebFetchProviderSnapshotCacheEntry>
      >();
      webFetchProviderSnapshotCache.set(cacheOwnerConfig, configCache);
    }
    let envCache = configCache.get(env);
    if (!envCache) {
      envCache = new Map<string, WebFetchProviderSnapshotCacheEntry>();
      configCache.set(env, envCache);
    }
    envCache.set(cacheKey, {
      expiresAt: Date.now() + ttlMs,
      providers: resolved,
    });
  }
  return resolved;
}

export function resolveRuntimeWebFetchProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
  onlyPluginIds?: readonly string[];
}): PluginWebFetchProviderEntry[] {
  const runtimeRegistry = resolveRuntimePluginRegistry(
    params.config === undefined ? undefined : resolveWebFetchLoadOptions(params),
  );
  if (runtimeRegistry) {
    return mapRegistryWebFetchProviders({
      registry: runtimeRegistry,
      onlyPluginIds: params.onlyPluginIds,
    });
  }
  return resolvePluginWebFetchProviders(params);
}
