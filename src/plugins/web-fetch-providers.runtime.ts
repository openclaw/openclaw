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
  origin?: PluginManifestRecord["origin"];
}): string[] | undefined {
  const contractIds = new Set(
    resolveManifestContractPluginIds({
      contract: "webFetchProviders",
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
        (contractIds.has(plugin.id) || pluginManifestDeclaresWebFetch(plugin)),
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
  origin?: PluginManifestRecord["origin"];
}) {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDir();
  const { config, activationSourceConfig, autoEnabledReasons } =
    resolveBundledWebFetchResolutionConfig({
      ...params,
      workspaceDir,
      env,
    });
  const onlyPluginIds = resolveWebFetchCandidatePluginIds({
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
  mode?: "runtime" | "setup";
  origin?: PluginManifestRecord["origin"];
}): PluginWebFetchProviderEntry[] {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDir();
  if (params.mode === "setup") {
    const pluginIds =
      resolveWebFetchCandidatePluginIds({
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
    return mapRegistryWebFetchProviders({ registry, onlyPluginIds: pluginIds });
  }
  const cacheOwnerConfig = params.config;
  const shouldMemoizeSnapshot =
    params.activate !== true && params.cache !== true && shouldUsePluginSnapshotCache(env);
  const cacheKey = buildWebFetchSnapshotCacheKey({
    config: cacheOwnerConfig,
    workspaceDir,
    bundledAllowlistCompat: params.bundledAllowlistCompat,
    onlyPluginIds: params.onlyPluginIds,
    origin: params.origin,
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
  const loadOptions = resolveWebFetchLoadOptions({ ...params, workspaceDir });
  // Keep repeated runtime reads on the already-compatible active registry when
  // possible, then fall back to a fresh snapshot load only when necessary.
  const resolved = mapRegistryWebFetchProviders({
    registry:
      resolveCompatibleRuntimePluginRegistry(loadOptions) ?? loadOpenClawPlugins(loadOptions),
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
  origin?: PluginManifestRecord["origin"];
}): PluginWebFetchProviderEntry[] {
  const runtimeRegistry = resolveRuntimePluginRegistry(
    params.config === undefined
      ? undefined
      : resolveWebFetchLoadOptions({
          ...params,
          workspaceDir: params.workspaceDir ?? getActivePluginRegistryWorkspaceDir(),
        }),
  );
  if (runtimeRegistry) {
    return mapRegistryWebFetchProviders({
      registry: runtimeRegistry,
      onlyPluginIds: params.onlyPluginIds,
    });
  }
  return resolvePluginWebFetchProviders(params);
}
