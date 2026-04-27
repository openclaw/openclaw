import { withActivatedPluginIds } from "../activation-context.js";
import { resolveChannelPluginIds, resolveConfiguredChannelPluginIds, } from "../channel-plugin-ids.js";
import { loadOpenClawPlugins, resolveRuntimePluginRegistry } from "../loader.js";
import { hasExplicitPluginIdScope, hasNonEmptyPluginIdScope, normalizePluginIdScope, } from "../plugin-scope.js";
import { getActivePluginRegistry } from "../runtime.js";
import { buildPluginRuntimeLoadOptionsFromValues, resolvePluginRuntimeLoadContext, } from "./load-context.js";
let pluginRegistryLoaded = "none";
function scopeRank(scope) {
    switch (scope) {
        case "none":
            return 0;
        case "configured-channels":
            return 1;
        case "channels":
            return 2;
        case "all":
            return 3;
    }
    throw new Error("Unsupported plugin registry scope");
}
function activeRegistrySatisfiesScope(scope, active, expectedChannelPluginIds, requestedPluginIds) {
    if (!active) {
        return false;
    }
    if (requestedPluginIds !== undefined) {
        if (requestedPluginIds.length === 0) {
            return false;
        }
        const activePluginIds = new Set(active.plugins.filter((plugin) => plugin.status === "loaded").map((plugin) => plugin.id));
        return requestedPluginIds.every((pluginId) => activePluginIds.has(pluginId));
    }
    const activeChannelPluginIds = new Set(active.channels.map((entry) => entry.plugin.id));
    switch (scope) {
        case "configured-channels":
        case "channels":
            return (active.channels.length > 0 &&
                expectedChannelPluginIds.every((pluginId) => activeChannelPluginIds.has(pluginId)));
        case "all":
            return false;
    }
    throw new Error("Unsupported plugin registry scope");
}
function shouldForwardChannelScope(params) {
    return !params.scopedLoad && params.scope === "configured-channels";
}
function resolveOrLoadRuntimePluginRegistry(loadOptions) {
    // Prefer the runtime resolver so broad ensures can reuse compatible active
    // registries, including gateway-bindable startup registries.
    if (!resolveRuntimePluginRegistry(loadOptions)) {
        loadOpenClawPlugins(loadOptions);
    }
}
export function ensurePluginRegistryLoaded(options) {
    const scope = options?.scope ?? "all";
    const requestedPluginIds = normalizePluginIdScope(options?.onlyPluginIds);
    const scopedLoad = hasExplicitPluginIdScope(requestedPluginIds);
    const context = resolvePluginRuntimeLoadContext(options);
    const expectedChannelPluginIds = scopedLoad
        ? (requestedPluginIds ?? [])
        : scope === "configured-channels"
            ? resolveConfiguredChannelPluginIds({
                config: context.config,
                activationSourceConfig: context.activationSourceConfig,
                workspaceDir: context.workspaceDir,
                env: context.env,
            })
            : scope === "channels"
                ? resolveChannelPluginIds({
                    config: context.config,
                    workspaceDir: context.workspaceDir,
                    env: context.env,
                })
                : [];
    const active = getActivePluginRegistry();
    if (!scopedLoad &&
        scopeRank(pluginRegistryLoaded) >= scopeRank(scope) &&
        activeRegistrySatisfiesScope(scope, active, expectedChannelPluginIds, undefined)) {
        return;
    }
    if ((pluginRegistryLoaded === "none" || scopedLoad) &&
        activeRegistrySatisfiesScope(scope, active, expectedChannelPluginIds, requestedPluginIds)) {
        if (!scopedLoad) {
            pluginRegistryLoaded = scope;
        }
        return;
    }
    const scopedConfig = !scopedLoad && scope === "configured-channels" && expectedChannelPluginIds.length > 0
        ? (withActivatedPluginIds({
            config: context.config,
            pluginIds: expectedChannelPluginIds,
        }) ?? context.config)
        : context.config;
    const scopedActivationSourceConfig = !scopedLoad && scope === "configured-channels" && expectedChannelPluginIds.length > 0
        ? (withActivatedPluginIds({
            config: context.activationSourceConfig,
            pluginIds: expectedChannelPluginIds,
        }) ?? context.activationSourceConfig)
        : context.activationSourceConfig;
    const loadOptions = buildPluginRuntimeLoadOptionsFromValues({
        ...context,
        config: scopedConfig,
        activationSourceConfig: scopedActivationSourceConfig,
    }, {
        throwOnLoadError: true,
        ...(hasExplicitPluginIdScope(requestedPluginIds) ||
            shouldForwardChannelScope({ scope, scopedLoad }) ||
            hasNonEmptyPluginIdScope(expectedChannelPluginIds)
            ? { onlyPluginIds: expectedChannelPluginIds }
            : {}),
    });
    resolveOrLoadRuntimePluginRegistry(loadOptions);
    if (!scopedLoad) {
        pluginRegistryLoaded = scope;
    }
}
export const __testing = {
    resetPluginRegistryLoadedForTests() {
        pluginRegistryLoaded = "none";
    },
};
