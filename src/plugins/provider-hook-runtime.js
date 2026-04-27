import { normalizeProviderId } from "../agents/provider-id.js";
import { normalizePluginIdScope, serializePluginIdScope } from "./plugin-scope.js";
import { isPluginProvidersLoadInFlight, resolvePluginProviders } from "./providers.runtime.js";
import { resolvePluginCacheInputs } from "./roots.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "./runtime-state.js";
function matchesProviderId(provider, providerId) {
    const normalized = normalizeProviderId(providerId);
    if (!normalized) {
        return false;
    }
    if (normalizeProviderId(provider.id) === normalized) {
        return true;
    }
    return [...(provider.aliases ?? []), ...(provider.hookAliases ?? [])].some((alias) => normalizeProviderId(alias) === normalized);
}
let cachedHookProvidersWithoutConfig = new WeakMap();
let cachedHookProvidersByConfig = new WeakMap();
function resolveHookProviderCacheBucket(params) {
    if (!params.config) {
        let bucket = cachedHookProvidersWithoutConfig.get(params.env);
        if (!bucket) {
            bucket = new Map();
            cachedHookProvidersWithoutConfig.set(params.env, bucket);
        }
        return bucket;
    }
    let envBuckets = cachedHookProvidersByConfig.get(params.config);
    if (!envBuckets) {
        envBuckets = new WeakMap();
        cachedHookProvidersByConfig.set(params.config, envBuckets);
    }
    let bucket = envBuckets.get(params.env);
    if (!bucket) {
        bucket = new Map();
        envBuckets.set(params.env, bucket);
    }
    return bucket;
}
function buildHookProviderCacheKey(params) {
    const { roots } = resolvePluginCacheInputs({
        workspaceDir: params.workspaceDir,
        env: params.env,
    });
    const onlyPluginIds = normalizePluginIdScope(params.onlyPluginIds);
    return `${roots.workspace ?? ""}::${roots.global}::${roots.stock ?? ""}::${JSON.stringify(params.config ?? null)}::${serializePluginIdScope(onlyPluginIds)}::${JSON.stringify(params.providerRefs ?? [])}`;
}
export function clearProviderRuntimeHookCache() {
    cachedHookProvidersWithoutConfig = new WeakMap();
    cachedHookProvidersByConfig = new WeakMap();
}
export function resetProviderRuntimeHookCacheForTest() {
    clearProviderRuntimeHookCache();
}
export const __testing = {
    buildHookProviderCacheKey,
};
export function resolveProviderPluginsForHooks(params) {
    const env = params.env ?? process.env;
    const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
    const cacheBucket = resolveHookProviderCacheBucket({
        config: params.config,
        env,
    });
    const cacheKey = buildHookProviderCacheKey({
        config: params.config,
        workspaceDir,
        onlyPluginIds: params.onlyPluginIds,
        providerRefs: params.providerRefs,
        env,
    });
    const cached = cacheBucket.get(cacheKey);
    if (cached) {
        return cached;
    }
    if (isPluginProvidersLoadInFlight({
        ...params,
        workspaceDir,
        env,
        activate: false,
        cache: false,
        bundledProviderAllowlistCompat: true,
        bundledProviderVitestCompat: true,
    })) {
        return [];
    }
    const resolved = resolvePluginProviders({
        ...params,
        workspaceDir,
        env,
        activate: false,
        cache: false,
        bundledProviderAllowlistCompat: true,
        bundledProviderVitestCompat: true,
    });
    cacheBucket.set(cacheKey, resolved);
    return resolved;
}
export function resolveProviderRuntimePlugin(params) {
    return resolveProviderPluginsForHooks({
        config: params.config,
        workspaceDir: params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState(),
        env: params.env,
        providerRefs: [params.provider],
    }).find((plugin) => matchesProviderId(plugin, params.provider));
}
export function resolveProviderHookPlugin(params) {
    return (resolveProviderRuntimePlugin(params) ??
        resolveProviderPluginsForHooks({
            config: params.config,
            workspaceDir: params.workspaceDir,
            env: params.env,
        }).find((candidate) => matchesProviderId(candidate, params.provider)));
}
export function prepareProviderExtraParams(params) {
    return resolveProviderRuntimePlugin(params)?.prepareExtraParams?.(params.context) ?? undefined;
}
export function resolveProviderExtraParamsForTransport(params) {
    return resolveProviderHookPlugin(params)?.extraParamsForTransport?.(params.context) ?? undefined;
}
export function resolveProviderAuthProfileId(params) {
    const resolved = resolveProviderHookPlugin(params)?.resolveAuthProfileId?.(params.context);
    return typeof resolved === "string" && resolved.trim() ? resolved.trim() : undefined;
}
export function resolveProviderFollowupFallbackRoute(params) {
    return resolveProviderHookPlugin(params)?.followupFallbackRoute?.(params.context) ?? undefined;
}
export function wrapProviderStreamFn(params) {
    return resolveProviderHookPlugin(params)?.wrapStreamFn?.(params.context) ?? undefined;
}
