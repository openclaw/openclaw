import { withActivatedPluginIds } from "./activation-context.js";
import { buildPluginSnapshotCacheEnvKey, resolvePluginSnapshotCacheTtlMs, shouldUsePluginSnapshotCache, } from "./cache-controls.js";
import { isPluginRegistryLoadInFlight, loadOpenClawPlugins, resolveCompatibleRuntimePluginRegistry, resolveRuntimePluginRegistry, } from "./loader.js";
import { hasExplicitPluginIdScope, normalizePluginIdScope } from "./plugin-scope.js";
import { getActivePluginRegistryWorkspaceDir } from "./runtime.js";
import { buildPluginRuntimeLoadOptionsFromValues, createPluginRuntimeLoaderLogger, } from "./runtime/load-context.js";
import { buildWebProviderSnapshotCacheKey } from "./web-provider-resolution-shared.js";
export function createWebProviderSnapshotCache() {
    return new WeakMap();
}
function resolveWebProviderLoadOptions(params, deps) {
    const env = params.env ?? process.env;
    const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDir();
    const { config, activationSourceConfig, autoEnabledReasons } = deps.resolveBundledResolutionConfig({
        ...params,
        workspaceDir,
        env,
    });
    const onlyPluginIds = normalizePluginIdScope(deps.resolveCandidatePluginIds({
        config,
        workspaceDir,
        env,
        onlyPluginIds: params.onlyPluginIds,
        origin: params.origin,
    }));
    return buildPluginRuntimeLoadOptionsFromValues({
        env,
        config,
        activationSourceConfig,
        autoEnabledReasons,
        workspaceDir,
        logger: createPluginRuntimeLoaderLogger(),
    }, {
        cache: params.cache ?? false,
        activate: params.activate ?? false,
        ...(hasExplicitPluginIdScope(onlyPluginIds) ? { onlyPluginIds } : {}),
    });
}
export function resolvePluginWebProviders(params, deps) {
    const env = params.env ?? process.env;
    const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDir();
    if (params.mode === "setup") {
        const pluginIds = deps.resolveCandidatePluginIds({
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
        const registry = loadOpenClawPlugins(buildPluginRuntimeLoadOptionsFromValues({
            config: withActivatedPluginIds({
                config: params.config,
                pluginIds,
            }),
            activationSourceConfig: params.config,
            autoEnabledReasons: {},
            workspaceDir,
            env,
            logger: createPluginRuntimeLoaderLogger(),
        }, {
            onlyPluginIds: pluginIds,
            cache: params.cache ?? false,
            activate: params.activate ?? false,
        }));
        return deps.mapRegistryProviders({ registry, onlyPluginIds: pluginIds });
    }
    const cacheOwnerConfig = params.config;
    const shouldMemoizeSnapshot = params.activate !== true && params.cache !== true && shouldUsePluginSnapshotCache(env);
    const cacheKey = buildWebProviderSnapshotCacheKey({
        config: cacheOwnerConfig,
        workspaceDir,
        bundledAllowlistCompat: params.bundledAllowlistCompat,
        onlyPluginIds: params.onlyPluginIds,
        origin: params.origin,
        envKey: buildPluginSnapshotCacheEnvKey(env),
    });
    if (cacheOwnerConfig && shouldMemoizeSnapshot) {
        const configCache = deps.snapshotCache.get(cacheOwnerConfig);
        const envCache = configCache?.get(env);
        const cached = envCache?.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.providers;
        }
    }
    const memoizeSnapshot = (providers) => {
        if (!cacheOwnerConfig || !shouldMemoizeSnapshot) {
            return;
        }
        const ttlMs = resolvePluginSnapshotCacheTtlMs(env);
        let configCache = deps.snapshotCache.get(cacheOwnerConfig);
        if (!configCache) {
            configCache = new WeakMap();
            deps.snapshotCache.set(cacheOwnerConfig, configCache);
        }
        let envCache = configCache.get(env);
        if (!envCache) {
            envCache = new Map();
            configCache.set(env, envCache);
        }
        envCache.set(cacheKey, {
            expiresAt: Date.now() + ttlMs,
            providers,
        });
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
export function resolveRuntimeWebProviders(params, deps) {
    const loadOptions = params.config === undefined ? undefined : resolveWebProviderLoadOptions(params, deps);
    const runtimeRegistry = resolveRuntimePluginRegistry(loadOptions);
    if (runtimeRegistry) {
        return deps.mapRegistryProviders({
            registry: runtimeRegistry,
            onlyPluginIds: params.onlyPluginIds,
        });
    }
    return resolvePluginWebProviders(params, deps);
}
