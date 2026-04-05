import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isRecord } from "../utils.js";
import { withActivatedPluginIds } from "./activation-context.js";
import {
  buildPluginSnapshotCacheEnvKey,
  resolvePluginSnapshotCacheTtlMs,
  shouldUsePluginSnapshotCache,
} from "./cache-controls.js";
import {
  loadOpenClawPlugins,
  resolveCompatibleRuntimePluginRegistry,
  resolveRuntimePluginRegistry,
} from "./loader.js";
import type { PluginLoadOptions } from "./loader.js";
import { createPluginLoaderLogger } from "./logger.js";
import {
  loadPluginManifestRegistry,
  resolveManifestContractPluginIds,
  type PluginManifestRecord,
} from "./manifest-registry.js";
import { getActivePluginRegistryWorkspaceDir } from "./runtime.js";
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
  origin?: PluginManifestRecord["origin"];
  env: NodeJS.ProcessEnv;
}): string {
  return JSON.stringify({
    workspaceDir: params.workspaceDir ?? "",
    bundledAllowlistCompat: params.bundledAllowlistCompat === true,
    origin: params.origin ?? "",
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
  origin?: PluginManifestRecord["origin"];
}): string[] | undefined {
  const contractIds = new Set(
    resolveManifestContractPluginIds({
      contract: "webSearchProviders",
      origin: params.origin,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      onlyPluginIds: params.onlyPluginIds,
    }),
  );
  const onlyPluginIdSet =
    params.onlyPluginIds && params.onlyPluginIds.length > 0 ? new Set(params.onlyPluginIds) : null;
  const ids = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  })
    .plugins.filter(
      (plugin) =>
        (!params.origin || plugin.origin === params.origin) &&
        (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.id)) &&
        (contractIds.has(plugin.id) || pluginManifestDeclaresWebSearch(plugin)),
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
  origin?: PluginManifestRecord["origin"];
}) {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDir();
  const { config, activationSourceConfig, autoEnabledReasons } =
    resolveBundledWebSearchResolutionConfig({
      ...params,
      workspaceDir,
      env,
    });
  const onlyPluginIds = resolveWebSearchCandidatePluginIds({
    config,
    workspaceDir,
    env,
    onlyPluginIds: params.onlyPluginIds,
    origin: params.origin,
  });
  return {
    env,
    config,
    activationSourceConfig,
    autoEnabledReasons,
    workspaceDir,
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
  mode?: "runtime" | "setup";
  origin?: PluginManifestRecord["origin"];
}): PluginWebSearchProviderEntry[] {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDir();
  if (params.mode === "setup") {
    const pluginIds =
      resolveWebSearchCandidatePluginIds({
        config: params.config,
        workspaceDir,
        env,
        onlyPluginIds: params.onlyPluginIds,
        origin: params.origin,
      }) ?? [];
    if (pluginIds.length === 0) {
      return [];
    }
    const registry = loadOpenClawPlugins({
      config: withActivatedPluginIds({
        config: params.config,
        pluginIds,
      }),
      activationSourceConfig: params.config,
      autoEnabledReasons: {},
      workspaceDir,
      env,
      onlyPluginIds: pluginIds,
      cache: params.cache ?? false,
      activate: params.activate ?? false,
      logger: createPluginLoaderLogger(log),
    });
    return mapRegistryWebSearchProviders({ registry, onlyPluginIds: pluginIds });
  }
  const cacheOwnerConfig = params.config;
  const shouldMemoizeSnapshot =
    params.activate !== true && params.cache !== true && shouldUsePluginSnapshotCache(env);
  const cacheKey = buildWebSearchSnapshotCacheKey({
    config: cacheOwnerConfig,
    workspaceDir,
    bundledAllowlistCompat: params.bundledAllowlistCompat,
    onlyPluginIds: params.onlyPluginIds,
    origin: params.origin,
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
  const loadOptions = resolveWebSearchLoadOptions({ ...params, workspaceDir });
  // Prefer the compatible active registry so repeated runtime reads do not
  // re-import the same plugin set through the snapshot path.
  const resolved = mapRegistryWebSearchProviders({
    registry:
      resolveCompatibleRuntimePluginRegistry(loadOptions) ?? loadOpenClawPlugins(loadOptions),
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
  origin?: PluginManifestRecord["origin"];
}): PluginWebSearchProviderEntry[] {
  const runtimeRegistry = resolveRuntimePluginRegistry(
    params.config === undefined
      ? undefined
      : resolveWebSearchLoadOptions({
          ...params,
          workspaceDir: params.workspaceDir ?? getActivePluginRegistryWorkspaceDir(),
        }),
  );
  if (runtimeRegistry) {
    return mapRegistryWebSearchProviders({
      registry: runtimeRegistry,
      onlyPluginIds: params.onlyPluginIds,
    });
  }
  return resolvePluginWebSearchProviders(params);
}
