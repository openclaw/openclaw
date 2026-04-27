import { normalizeProviderId } from "../agents/provider-id.js";
import { withBundledPluginVitestCompat } from "./bundled-compat.js";
import { resolveEffectivePluginActivationState } from "./config-state.js";
import { isActivatedManifestOwner, passesManifestOwnerBasePolicy, } from "./manifest-owner-policy.js";
import { loadPluginManifestRegistry, } from "./manifest-registry.js";
import { loadPluginRegistrySnapshot, normalizePluginsConfigWithRegistry, resolvePluginContributionOwners, resolveProviderOwners, } from "./plugin-registry.js";
import { createPluginIdScopeSet } from "./plugin-scope.js";
function loadProviderManifestRegistry(params) {
    return loadPluginManifestRegistry({
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
    });
}
function loadProviderRegistrySnapshot(params) {
    return loadPluginRegistrySnapshot({
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
    });
}
function loadScopedProviderRegistry(params) {
    return {
        registry: loadProviderRegistrySnapshot(params),
        onlyPluginIdSet: createPluginIdScopeSet(params.onlyPluginIds),
    };
}
function listRegistryPluginIds(registry, predicate) {
    return registry.plugins
        .filter(predicate)
        .map((plugin) => plugin.pluginId)
        .toSorted((left, right) => left.localeCompare(right));
}
function resolveProviderOwnerPluginIds(params) {
    if (params.pluginIds.length === 0) {
        return [];
    }
    const pluginIdSet = new Set(params.pluginIds);
    const registry = loadProviderRegistrySnapshot(params);
    const normalizedConfig = normalizePluginsConfigWithRegistry(params.config?.plugins, registry);
    return listRegistryPluginIds(registry, (plugin) => pluginIdSet.has(plugin.pluginId) && params.isEligible(plugin, normalizedConfig));
}
function recordHasProviderSurface(plugin) {
    return plugin.contributions.providers.length > 0;
}
function resolveEffectiveRegistryPluginActivation(params) {
    return resolveEffectivePluginActivationState({
        id: params.plugin.pluginId,
        origin: params.plugin.origin,
        config: params.normalizedConfig,
        rootConfig: params.rootConfig,
        enabledByDefault: params.plugin.enabledByDefault,
    });
}
function toManifestOwnerRecord(plugin) {
    return {
        id: plugin.pluginId,
        origin: plugin.origin,
        enabledByDefault: plugin.enabledByDefault,
    };
}
export function withBundledProviderVitestCompat(params) {
    return withBundledPluginVitestCompat(params);
}
export function resolveBundledProviderCompatPluginIds(params) {
    const { registry, onlyPluginIdSet } = loadScopedProviderRegistry(params);
    return listRegistryPluginIds(registry, (plugin) => plugin.origin === "bundled" &&
        recordHasProviderSurface(plugin) &&
        (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.pluginId)));
}
export function resolveEnabledProviderPluginIds(params) {
    const { registry, onlyPluginIdSet } = loadScopedProviderRegistry(params);
    const normalizedConfig = normalizePluginsConfigWithRegistry(params.config?.plugins, registry);
    return listRegistryPluginIds(registry, (plugin) => recordHasProviderSurface(plugin) &&
        (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.pluginId)) &&
        resolveEffectiveRegistryPluginActivation({
            plugin,
            normalizedConfig,
            rootConfig: params.config,
        }).activated);
}
export function resolveExternalAuthProfileProviderPluginIds(params) {
    return resolveRegistryManifestContractPluginIds({
        ...params,
        contract: "externalAuthProviders",
    });
}
function resolveRegistryManifestContractPluginIds(params) {
    const { registry, onlyPluginIdSet } = loadScopedProviderRegistry(params);
    return listRegistryPluginIds(registry, (plugin) => {
        if (params.origin && plugin.origin !== params.origin) {
            return false;
        }
        if (onlyPluginIdSet && !onlyPluginIdSet.has(plugin.pluginId)) {
            return false;
        }
        return plugin.contributions.contracts.includes(params.contract);
    });
}
export function resolveExternalAuthProfileCompatFallbackPluginIds(params) {
    // Deprecated compatibility fallback for provider plugins that still implement
    // resolveExternalOAuthProfiles or omit contracts.externalAuthProviders. Remove
    // this with the warning path in provider-runtime after the migration window.
    const declaredPluginIds = params.declaredPluginIds ?? new Set(resolveExternalAuthProfileProviderPluginIds(params));
    const registry = loadProviderRegistrySnapshot(params);
    const normalizedConfig = normalizePluginsConfigWithRegistry(params.config?.plugins, registry);
    return listRegistryPluginIds(registry, (plugin) => plugin.origin !== "bundled" &&
        recordHasProviderSurface(plugin) &&
        !declaredPluginIds.has(plugin.pluginId) &&
        isProviderPluginEligibleForRuntimeOwnerActivation({
            plugin,
            normalizedConfig,
            rootConfig: params.config,
        }));
}
export function resolveDiscoveredProviderPluginIds(params) {
    const { registry, onlyPluginIdSet } = loadScopedProviderRegistry(params);
    const shouldFilterUntrustedWorkspacePlugins = params.includeUntrustedWorkspacePlugins === false;
    const normalizedConfig = normalizePluginsConfigWithRegistry(params.config?.plugins, registry);
    return listRegistryPluginIds(registry, (plugin) => {
        if (!(recordHasProviderSurface(plugin) &&
            (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.pluginId)))) {
            return false;
        }
        return isProviderPluginEligibleForSetupDiscovery({
            plugin,
            shouldFilterUntrustedWorkspacePlugins,
            normalizedConfig,
            rootConfig: params.config,
        });
    });
}
function isProviderPluginEligibleForSetupDiscovery(params) {
    if (!params.shouldFilterUntrustedWorkspacePlugins || params.plugin.origin !== "workspace") {
        return true;
    }
    if (!passesManifestOwnerBasePolicy({
        plugin: toManifestOwnerRecord(params.plugin),
        normalizedConfig: params.normalizedConfig,
    })) {
        return false;
    }
    return isActivatedManifestOwner({
        plugin: toManifestOwnerRecord(params.plugin),
        normalizedConfig: params.normalizedConfig,
        rootConfig: params.rootConfig,
    });
}
export function resolveDiscoverableProviderOwnerPluginIds(params) {
    const shouldFilterUntrustedWorkspacePlugins = params.includeUntrustedWorkspacePlugins === false;
    return resolveProviderOwnerPluginIds({
        ...params,
        isEligible: (plugin, normalizedConfig) => isProviderPluginEligibleForSetupDiscovery({
            plugin,
            shouldFilterUntrustedWorkspacePlugins,
            normalizedConfig,
            rootConfig: params.config,
        }),
    });
}
function isProviderPluginEligibleForRuntimeOwnerActivation(params) {
    if (!passesManifestOwnerBasePolicy({
        plugin: toManifestOwnerRecord(params.plugin),
        normalizedConfig: params.normalizedConfig,
    })) {
        return false;
    }
    if (params.plugin.origin !== "workspace") {
        return true;
    }
    return isActivatedManifestOwner({
        plugin: toManifestOwnerRecord(params.plugin),
        normalizedConfig: params.normalizedConfig,
        rootConfig: params.rootConfig,
    });
}
export function resolveActivatableProviderOwnerPluginIds(params) {
    return resolveProviderOwnerPluginIds({
        ...params,
        isEligible: (plugin, normalizedConfig) => isProviderPluginEligibleForRuntimeOwnerActivation({
            plugin,
            normalizedConfig,
            rootConfig: params.config,
        }),
    });
}
export const __testing = {
    resolveActivatableProviderOwnerPluginIds,
    resolveEnabledProviderPluginIds,
    resolveExternalAuthProfileCompatFallbackPluginIds,
    resolveExternalAuthProfileProviderPluginIds,
    resolveDiscoveredProviderPluginIds,
    resolveDiscoverableProviderOwnerPluginIds,
    resolveBundledProviderCompatPluginIds,
    withBundledProviderVitestCompat,
};
function resolveManifestRegistry(params) {
    return params.manifestRegistry ?? loadProviderManifestRegistry(params);
}
function stripModelProfileSuffix(value) {
    const trimmed = value.trim();
    const at = trimmed.indexOf("@");
    return at <= 0 ? trimmed : trimmed.slice(0, at).trim();
}
function splitExplicitModelRef(rawModel) {
    const trimmed = rawModel.trim();
    if (!trimmed) {
        return null;
    }
    const slash = trimmed.indexOf("/");
    if (slash === -1) {
        const modelId = stripModelProfileSuffix(trimmed);
        return modelId ? { modelId } : null;
    }
    const provider = normalizeProviderId(trimmed.slice(0, slash));
    const modelId = stripModelProfileSuffix(trimmed.slice(slash + 1));
    if (!provider || !modelId) {
        return null;
    }
    return { provider, modelId };
}
function resolveModelSupportMatchKind(plugin, modelId) {
    const patterns = plugin.modelSupport?.modelPatterns ?? [];
    for (const patternSource of patterns) {
        try {
            if (new RegExp(patternSource, "u").test(modelId)) {
                return "pattern";
            }
        }
        catch {
            continue;
        }
    }
    const prefixes = plugin.modelSupport?.modelPrefixes ?? [];
    for (const prefix of prefixes) {
        if (modelId.startsWith(prefix)) {
            return "prefix";
        }
    }
    return undefined;
}
function dedupeSortedPluginIds(values) {
    return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}
function resolvePreferredManifestPluginIds(registry, matchedPluginIds) {
    if (matchedPluginIds.length === 0) {
        return undefined;
    }
    const uniquePluginIds = dedupeSortedPluginIds(matchedPluginIds);
    if (uniquePluginIds.length <= 1) {
        return uniquePluginIds;
    }
    const nonBundledPluginIds = uniquePluginIds.filter((pluginId) => {
        const plugin = registry.plugins.find((entry) => entry.id === pluginId);
        return plugin?.origin !== "bundled";
    });
    if (nonBundledPluginIds.length === 1) {
        return nonBundledPluginIds;
    }
    if (nonBundledPluginIds.length > 1) {
        return undefined;
    }
    return undefined;
}
export function resolveOwningPluginIdsForProvider(params) {
    const normalizedProvider = normalizeProviderId(params.provider);
    if (!normalizedProvider) {
        return undefined;
    }
    if (params.manifestRegistry) {
        const pluginIds = params.manifestRegistry.plugins
            .filter((plugin) => plugin.providers.some((providerId) => normalizeProviderId(providerId) === normalizedProvider) ||
            plugin.cliBackends.some((backendId) => normalizeProviderId(backendId) === normalizedProvider))
            .map((plugin) => plugin.id);
        return pluginIds.length > 0 ? pluginIds : undefined;
    }
    const pluginIds = [
        ...resolveProviderOwners({
            config: params.config,
            workspaceDir: params.workspaceDir,
            env: params.env,
            providerId: normalizedProvider,
            includeDisabled: true,
        }),
        ...resolvePluginContributionOwners({
            config: params.config,
            workspaceDir: params.workspaceDir,
            env: params.env,
            contribution: "cliBackends",
            matches: (backendId) => normalizeProviderId(backendId) === normalizedProvider,
            includeDisabled: true,
        }),
    ];
    const deduped = dedupeSortedPluginIds(pluginIds);
    return deduped.length > 0 ? deduped : undefined;
}
export function resolveOwningPluginIdsForModelRef(params) {
    const parsed = splitExplicitModelRef(params.model);
    if (!parsed) {
        return undefined;
    }
    if (parsed.provider) {
        return resolveOwningPluginIdsForProvider({
            provider: parsed.provider,
            config: params.config,
            workspaceDir: params.workspaceDir,
            env: params.env,
            manifestRegistry: params.manifestRegistry,
        });
    }
    const registry = resolveManifestRegistry(params);
    const matchedByPattern = registry.plugins
        .filter((plugin) => resolveModelSupportMatchKind(plugin, parsed.modelId) === "pattern")
        .map((plugin) => plugin.id);
    const preferredPatternPluginIds = resolvePreferredManifestPluginIds(registry, matchedByPattern);
    if (preferredPatternPluginIds) {
        return preferredPatternPluginIds;
    }
    const matchedByPrefix = registry.plugins
        .filter((plugin) => resolveModelSupportMatchKind(plugin, parsed.modelId) === "prefix")
        .map((plugin) => plugin.id);
    return resolvePreferredManifestPluginIds(registry, matchedByPrefix);
}
export function resolveOwningPluginIdsForModelRefs(params) {
    const registry = resolveManifestRegistry(params);
    return dedupeSortedPluginIds(params.models.flatMap((model) => resolveOwningPluginIdsForModelRef({
        model,
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        manifestRegistry: registry,
    }) ?? []));
}
export function resolveNonBundledProviderPluginIds(params) {
    const registry = loadProviderRegistrySnapshot(params);
    const normalizedConfig = normalizePluginsConfigWithRegistry(params.config?.plugins, registry);
    return listRegistryPluginIds(registry, (plugin) => plugin.origin !== "bundled" &&
        recordHasProviderSurface(plugin) &&
        resolveEffectiveRegistryPluginActivation({
            plugin,
            normalizedConfig,
            rootConfig: params.config,
        }).activated);
}
export function resolveCatalogHookProviderPluginIds(params) {
    const registry = loadProviderRegistrySnapshot(params);
    const normalizedConfig = normalizePluginsConfigWithRegistry(params.config?.plugins, registry);
    const enabledProviderPluginIds = listRegistryPluginIds(registry, (plugin) => recordHasProviderSurface(plugin) &&
        resolveEffectiveRegistryPluginActivation({
            plugin,
            normalizedConfig,
            rootConfig: params.config,
        }).activated);
    const bundledCompatPluginIds = resolveBundledProviderCompatPluginIds(params);
    return [...new Set([...enabledProviderPluginIds, ...bundledCompatPluginIds])].toSorted((left, right) => left.localeCompare(right));
}
