import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isRecord } from "../utils.js";
import { loadOpenClawPlugins } from "./loader.js";
import type { PluginLoadOptions } from "./loader.js";
import { createPluginLoaderLogger } from "./logger.js";
import { loadPluginManifestRegistry, type PluginManifestRecord } from "./manifest-registry.js";
import { getActivePluginRegistry } from "./runtime.js";
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

const DEFAULT_DISCOVERY_CACHE_MS = 1000;
const DEFAULT_MANIFEST_CACHE_MS = 1000;

function shouldUseWebSearchProviderSnapshotCache(env: NodeJS.ProcessEnv): boolean {
  if (env.OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE?.trim()) {
    return false;
  }
  if (env.OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE?.trim()) {
    return false;
  }
  const discoveryCacheMs = env.OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS?.trim();
  if (discoveryCacheMs === "0") {
    return false;
  }
  const manifestCacheMs = env.OPENCLAW_PLUGIN_MANIFEST_CACHE_MS?.trim();
  if (manifestCacheMs === "0") {
    return false;
  }
  return true;
}

function resolveWebSearchProviderSnapshotCacheTtlMs(env: NodeJS.ProcessEnv): number {
  const discoveryCacheMs = resolveCacheMs(
    env.OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS,
    DEFAULT_DISCOVERY_CACHE_MS,
  );
  const manifestCacheMs = resolveCacheMs(
    env.OPENCLAW_PLUGIN_MANIFEST_CACHE_MS,
    DEFAULT_MANIFEST_CACHE_MS,
  );
  return Math.min(discoveryCacheMs, manifestCacheMs);
}

function resolveCacheMs(rawValue: string | undefined, defaultMs: number): number {
  const raw = rawValue?.trim();
  if (raw === "" || raw === "0") {
    return 0;
  }
  if (!raw) {
    return defaultMs;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return defaultMs;
  }
  return Math.max(0, parsed);
}

function buildWebSearchSnapshotCacheKey(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  bundledAllowlistCompat?: boolean;
  env: NodeJS.ProcessEnv;
}): string {
  const effectiveVitest = params.env.VITEST ?? process.env.VITEST ?? "";
  return JSON.stringify({
    workspaceDir: params.workspaceDir ?? "",
    bundledAllowlistCompat: params.bundledAllowlistCompat === true,
    config: params.config ?? null,
    env: {
      OPENCLAW_BUNDLED_PLUGINS_DIR: params.env.OPENCLAW_BUNDLED_PLUGINS_DIR ?? "",
      OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE:
        params.env.OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE ?? "",
      OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE:
        params.env.OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE ?? "",
      OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: params.env.OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS ?? "",
      OPENCLAW_PLUGIN_MANIFEST_CACHE_MS: params.env.OPENCLAW_PLUGIN_MANIFEST_CACHE_MS ?? "",
      OPENCLAW_HOME: params.env.OPENCLAW_HOME ?? "",
      OPENCLAW_STATE_DIR: params.env.OPENCLAW_STATE_DIR ?? "",
      OPENCLAW_CONFIG_PATH: params.env.OPENCLAW_CONFIG_PATH ?? "",
      HOME: params.env.HOME ?? "",
      USERPROFILE: params.env.USERPROFILE ?? "",
      VITEST: effectiveVitest,
    },
  });
}

function pluginManifestDeclaresWebSearch(record: PluginManifestRecord): boolean {
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
}): string[] | undefined {
  const registry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const ids = registry.plugins
    .filter(pluginManifestDeclaresWebSearch)
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
  return ids.length > 0 ? ids : undefined;
}

export function resolvePluginWebSearchProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
  activate?: boolean;
  cache?: boolean;
}): PluginWebSearchProviderEntry[] {
  const env = params.env ?? process.env;
  const cacheOwnerConfig = params.config;
  const shouldMemoizeSnapshot =
    params.activate !== true &&
    params.cache !== true &&
    shouldUseWebSearchProviderSnapshotCache(env);
  const cacheKey = buildWebSearchSnapshotCacheKey({
    config: cacheOwnerConfig,
    workspaceDir: params.workspaceDir,
    bundledAllowlistCompat: params.bundledAllowlistCompat,
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
  const { config } = resolveBundledWebSearchResolutionConfig({
    ...params,
    env,
  });
  const onlyPluginIds = resolveWebSearchCandidatePluginIds({
    config,
    workspaceDir: params.workspaceDir,
    env,
  });
  const registry = loadOpenClawPlugins({
    config,
    workspaceDir: params.workspaceDir,
    env,
    cache: params.cache ?? false,
    activate: params.activate ?? false,
    ...(onlyPluginIds ? { onlyPluginIds } : {}),
    logger: createPluginLoaderLogger(log),
  });

  const resolved = sortWebSearchProviders(
    registry.webSearchProviders.map((entry) => ({
      ...entry.provider,
      pluginId: entry.pluginId,
    })),
  );
  if (cacheOwnerConfig && shouldMemoizeSnapshot) {
    const ttlMs = resolveWebSearchProviderSnapshotCacheTtlMs(env);
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
}): PluginWebSearchProviderEntry[] {
  const runtimeProviders = getActivePluginRegistry()?.webSearchProviders ?? [];
  if (runtimeProviders.length > 0) {
    return sortWebSearchProviders(
      runtimeProviders.map((entry) => ({
        ...entry.provider,
        pluginId: entry.pluginId,
      })),
    );
  }
  return resolvePluginWebSearchProviders(params);
}
