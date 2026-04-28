import { withActivatedPluginIds } from "./activation-context.js";
import {
  buildPluginSnapshotCacheEnvKey,
  resolvePluginSnapshotCacheTtlMs,
  shouldUsePluginSnapshotCache,
} from "./cache-controls.js";
import {
  isPluginRegistryLoadInFlight,
  loadOpenClawPlugins,
  resolveCompatibleRuntimePluginRegistry,
  resolveRuntimePluginRegistry,
} from "./loader.js";
import type { PluginLoadOptions } from "./loader.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { hasExplicitPluginIdScope, normalizePluginIdScope } from "./plugin-scope.js";
import type { PluginRegistry } from "./registry.js";
import { getActivePluginRegistryWorkspaceDir } from "./runtime.js";
import {
  buildPluginRuntimeLoadOptionsFromValues,
  createPluginRuntimeLoaderLogger,
} from "./runtime/load-context.js";
import { buildWebProviderSnapshotCacheKey } from "./web-provider-resolution-shared.js";

type WebProviderSnapshotCacheEntry<TEntry> = {
  expiresAt: number;
  providers: TEntry[];
};

/**
 * Web-provider snapshot cache.
 *
 * Original shape was `WeakMap<OpenClawConfig, WeakMap<NodeJS.ProcessEnv, Map<key, Entry>>>`,
 * keyed on object identity. As described in #73730, callers like
 * `resolveWebSearchRuntimeConfig` and `resolveWebFetchRuntimeConfig` build
 * a fresh `config` object per dispatch, so the outer `WeakMap` lookup never
 * hit and every message paid the full ~30s plugin-load cost.
 *
 * The cache is now keyed entirely on `buildWebProviderSnapshotCacheKey`, which
 * encodes workspaceDir + allowlistCompat + origin + onlyPluginIds + envKey
 * plus a content fingerprint of the resolution-relevant config subset (see
 * `fingerprintWebProviderResolutionConfig`). Callers building fresh config
 * objects with the same content now produce the same cache key and hit the
 * cache; genuinely different configs produce different keys and stay isolated.
 *
 * TTL eviction continues to rely on `expiresAt`; without per-config WeakMap
 * GC the cache size grows monotonically until entries expire, but the
 * existing `resolvePluginSnapshotCacheTtlMs` already bounds that growth.
 */
export type WebProviderSnapshotCache<TEntry> = Map<string, WebProviderSnapshotCacheEntry<TEntry>>;

export type ResolvePluginWebProvidersParams = {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
  onlyPluginIds?: readonly string[];
  activate?: boolean;
  cache?: boolean;
  mode?: "runtime" | "setup";
  origin?: PluginManifestRecord["origin"];
};

type ResolveWebProviderRuntimeDeps<TEntry> = {
  snapshotCache: WebProviderSnapshotCache<TEntry>;
  resolveBundledResolutionConfig: (params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    bundledAllowlistCompat?: boolean;
  }) => {
    config: PluginLoadOptions["config"];
    activationSourceConfig?: PluginLoadOptions["config"];
    autoEnabledReasons: Record<string, string[]>;
  };
  resolveCandidatePluginIds: (params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    onlyPluginIds?: readonly string[];
    origin?: PluginManifestRecord["origin"];
  }) => string[] | undefined;
  mapRegistryProviders: (params: {
    registry: PluginRegistry;
    onlyPluginIds?: readonly string[];
  }) => TEntry[];
  resolveBundledPublicArtifactProviders?: (params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    bundledAllowlistCompat?: boolean;
    onlyPluginIds?: readonly string[];
  }) => TEntry[] | null;
};

export function createWebProviderSnapshotCache<TEntry>(): WebProviderSnapshotCache<TEntry> {
  return new Map<string, WebProviderSnapshotCacheEntry<TEntry>>();
}

/**
 * Soft cap on snapshot-cache size. Without the per-config WeakMap GC the cache
 * grows by one entry per distinct (workspace × allowlist × scope × env ×
 * config-fingerprint) combination, which is bounded in practice but can drift
 * under config-edit churn. When the cache exceeds the cap, drop expired
 * entries first; if still over, drop the oldest insertion-order entries down
 * to the cap so total footprint stays predictable.
 */
const SNAPSHOT_CACHE_SOFT_CAP = 256;

function pruneSnapshotCache<TEntry>(cache: WebProviderSnapshotCache<TEntry>): void {
  if (cache.size <= SNAPSHOT_CACHE_SOFT_CAP) {
    return;
  }
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
  if (cache.size <= SNAPSHOT_CACHE_SOFT_CAP) {
    return;
  }
  const keysToDrop = cache.size - SNAPSHOT_CACHE_SOFT_CAP;
  let dropped = 0;
  for (const key of cache.keys()) {
    if (dropped >= keysToDrop) {
      break;
    }
    cache.delete(key);
    dropped += 1;
  }
}

function resolveWebProviderLoadOptions<TEntry>(
  params: ResolvePluginWebProvidersParams,
  deps: ResolveWebProviderRuntimeDeps<TEntry>,
) {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDir();
  const { config, activationSourceConfig, autoEnabledReasons } =
    deps.resolveBundledResolutionConfig({
      ...params,
      workspaceDir,
      env,
    });
  const onlyPluginIds = normalizePluginIdScope(
    deps.resolveCandidatePluginIds({
      config,
      workspaceDir,
      env,
      onlyPluginIds: params.onlyPluginIds,
      origin: params.origin,
    }),
  );
  return buildPluginRuntimeLoadOptionsFromValues(
    {
      env,
      config,
      activationSourceConfig,
      autoEnabledReasons,
      workspaceDir,
      logger: createPluginRuntimeLoaderLogger(),
    },
    {
      cache: params.cache ?? false,
      activate: params.activate ?? false,
      ...(hasExplicitPluginIdScope(onlyPluginIds) ? { onlyPluginIds } : {}),
    },
  );
}

export function resolvePluginWebProviders<TEntry>(
  params: ResolvePluginWebProvidersParams,
  deps: ResolveWebProviderRuntimeDeps<TEntry>,
): TEntry[] {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDir();
  if (params.mode === "setup") {
    const pluginIds =
      deps.resolveCandidatePluginIds({
        config: params.config,
        workspaceDir,
        env,
        onlyPluginIds: params.onlyPluginIds,
        origin: params.origin,
      }) ?? [];
    if (pluginIds.length === 0) {
      return [];
    }
    if (params.activate !== true) {
      const bundledArtifactProviders = deps.resolveBundledPublicArtifactProviders?.({
        config: params.config,
        workspaceDir,
        env,
        bundledAllowlistCompat: params.bundledAllowlistCompat,
        onlyPluginIds: pluginIds,
      });
      if (bundledArtifactProviders) {
        return bundledArtifactProviders;
      }
    }
    const registry = loadOpenClawPlugins(
      buildPluginRuntimeLoadOptionsFromValues(
        {
          config: withActivatedPluginIds({
            config: params.config,
            pluginIds,
          }),
          activationSourceConfig: params.config,
          autoEnabledReasons: {},
          workspaceDir,
          env,
          logger: createPluginRuntimeLoaderLogger(),
        },
        {
          onlyPluginIds: pluginIds,
          cache: params.cache ?? false,
          activate: params.activate ?? false,
        },
      ),
    );
    return deps.mapRegistryProviders({ registry, onlyPluginIds: pluginIds });
  }

  const shouldMemoizeSnapshot =
    params.activate !== true && params.cache !== true && shouldUsePluginSnapshotCache(env);
  // The cache key now encodes the resolution-relevant config-content
  // fingerprint (#73730) instead of relying on object identity, so callers
  // that build a fresh `params.config` per dispatch but with the same
  // content hit the same entry.
  const cacheKey = buildWebProviderSnapshotCacheKey({
    config: params.config,
    workspaceDir,
    bundledAllowlistCompat: params.bundledAllowlistCompat,
    onlyPluginIds: params.onlyPluginIds,
    origin: params.origin,
    envKey: buildPluginSnapshotCacheEnvKey(env),
  });
  if (shouldMemoizeSnapshot) {
    const cached = deps.snapshotCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.providers;
    }
  }
  const memoizeSnapshot = (providers: TEntry[]) => {
    if (!shouldMemoizeSnapshot) {
      return;
    }
    const ttlMs = resolvePluginSnapshotCacheTtlMs(env);
    deps.snapshotCache.set(cacheKey, {
      expiresAt: Date.now() + ttlMs,
      providers,
    });
    pruneSnapshotCache(deps.snapshotCache);
  };

  const loadOptions = resolveWebProviderLoadOptions(params, deps);
  const compatible = resolveCompatibleRuntimePluginRegistry(loadOptions);
  if (compatible) {
    const resolved = deps.mapRegistryProviders({
      registry: compatible,
      onlyPluginIds: params.onlyPluginIds,
    });
    memoizeSnapshot(resolved);
    return resolved;
  }
  if (isPluginRegistryLoadInFlight(loadOptions)) {
    return [];
  }
  const resolved = deps.mapRegistryProviders({
    registry: loadOpenClawPlugins(loadOptions),
    onlyPluginIds: params.onlyPluginIds,
  });
  memoizeSnapshot(resolved);
  return resolved;
}

export function resolveRuntimeWebProviders<TEntry>(
  params: Omit<ResolvePluginWebProvidersParams, "activate" | "cache" | "mode">,
  deps: ResolveWebProviderRuntimeDeps<TEntry>,
): TEntry[] {
  const loadOptions =
    params.config === undefined ? undefined : resolveWebProviderLoadOptions(params, deps);
  const runtimeRegistry = resolveRuntimePluginRegistry(loadOptions);
  if (runtimeRegistry) {
    return deps.mapRegistryProviders({
      registry: runtimeRegistry,
      onlyPluginIds: params.onlyPluginIds,
    });
  }
  return resolvePluginWebProviders(params, deps);
}
