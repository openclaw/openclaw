import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { loadOpenClawPlugins } from "./loader.js";
import type { PluginLoadOptions } from "./loader.js";
import { createPluginLoaderLogger } from "./logger.js";
import { getActivePluginRegistry } from "./runtime.js";
import type { PluginWebSearchProviderEntry } from "./types.js";
import {
  resolveBundledWebSearchResolutionConfig,
  sortWebSearchProviders,
} from "./web-search-providers.shared.js";

const log = createSubsystemLogger("plugins");
const webSearchProviderSnapshotCache = new WeakMap<
  OpenClawConfig,
  WeakMap<NodeJS.ProcessEnv, Map<string, PluginWebSearchProviderEntry[]>>
>();

function shouldUseWebSearchProviderSnapshotCache(env: NodeJS.ProcessEnv): boolean {
  if (env.OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE?.trim()) {
    return false;
  }
  if (env.OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE?.trim()) {
    return false;
  }
  const manifestCacheMs = env.OPENCLAW_PLUGIN_MANIFEST_CACHE_MS?.trim();
  if (manifestCacheMs === "0") {
    return false;
  }
  return true;
}

function buildWebSearchSnapshotCacheKey(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  bundledAllowlistCompat?: boolean;
  env: NodeJS.ProcessEnv;
}): string {
  return JSON.stringify({
    workspaceDir: params.workspaceDir ?? "",
    bundledAllowlistCompat: params.bundledAllowlistCompat === true,
    config: params.config ?? null,
    env: {
      OPENCLAW_BUNDLED_PLUGINS_DIR: params.env.OPENCLAW_BUNDLED_PLUGINS_DIR ?? "",
      OPENCLAW_HOME: params.env.OPENCLAW_HOME ?? "",
      OPENCLAW_STATE_DIR: params.env.OPENCLAW_STATE_DIR ?? "",
      CLAWDBOT_STATE_DIR: params.env.CLAWDBOT_STATE_DIR ?? "",
      OPENCLAW_CONFIG_PATH: params.env.OPENCLAW_CONFIG_PATH ?? "",
      HOME: params.env.HOME ?? "",
      USERPROFILE: params.env.USERPROFILE ?? "",
      VITEST: params.env.VITEST ?? "",
    },
  });
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
    if (cached) {
      return cached;
    }
  }
  const { config } = resolveBundledWebSearchResolutionConfig({
    ...params,
    env,
  });
  const registry = loadOpenClawPlugins({
    config,
    workspaceDir: params.workspaceDir,
    env,
    cache: params.cache ?? false,
    activate: params.activate ?? false,
    logger: createPluginLoaderLogger(log),
  });

  const resolved = sortWebSearchProviders(
    registry.webSearchProviders.map((entry) => ({
      ...entry.provider,
      pluginId: entry.pluginId,
    })),
  );
  if (cacheOwnerConfig && shouldMemoizeSnapshot) {
    let configCache = webSearchProviderSnapshotCache.get(cacheOwnerConfig);
    if (!configCache) {
      configCache = new WeakMap<NodeJS.ProcessEnv, Map<string, PluginWebSearchProviderEntry[]>>();
      webSearchProviderSnapshotCache.set(cacheOwnerConfig, configCache);
    }
    let envCache = configCache.get(env);
    if (!envCache) {
      envCache = new Map<string, PluginWebSearchProviderEntry[]>();
      configCache.set(env, envCache);
    }
    envCache.set(cacheKey, resolved);
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
