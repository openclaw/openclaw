import { normalizeOptionalLowercaseString, normalizeOptionalString, } from "../shared/string-coerce.js";
import { createEffectiveEnableStateResolver, createPluginEnableStateResolver, resolveMemorySlotDecisionShared, resolvePluginActivationDecisionShared, toPluginActivationState, } from "./config-activation-shared.js";
import { hasExplicitPluginConfig as hasExplicitPluginConfigShared, isBundledChannelEnabledByChannelConfig as isBundledChannelEnabledByChannelConfigShared, normalizePluginsConfigWithResolver, } from "./config-normalization-shared.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { defaultSlotIdForKey } from "./slots.js";
let bundledPluginAliasLookupCache;
const BUILT_IN_PLUGIN_ALIAS_FALLBACKS = [
    ["openai-codex", "openai"],
    ["google-gemini-cli", "google"],
    ["minimax-portal", "minimax"],
    ["minimax-portal-auth", "minimax"],
];
const BUILT_IN_PLUGIN_ALIAS_LOOKUP = new Map([
    ...BUILT_IN_PLUGIN_ALIAS_FALLBACKS,
    ...BUILT_IN_PLUGIN_ALIAS_FALLBACKS.map(([, pluginId]) => [pluginId, pluginId]),
]);
function getBundledPluginAliasLookup() {
    if (bundledPluginAliasLookupCache) {
        return bundledPluginAliasLookupCache;
    }
    const lookup = new Map();
    for (const plugin of loadPluginManifestRegistry({ cache: true }).plugins) {
        if (plugin.origin !== "bundled") {
            continue;
        }
        const pluginId = normalizeOptionalLowercaseString(plugin.id);
        if (pluginId) {
            lookup.set(pluginId, plugin.id);
        }
        for (const providerId of plugin.providers) {
            const normalizedProviderId = normalizeOptionalLowercaseString(providerId);
            if (normalizedProviderId) {
                lookup.set(normalizedProviderId, plugin.id);
            }
        }
        for (const legacyPluginId of plugin.legacyPluginIds ?? []) {
            const normalizedLegacyPluginId = normalizeOptionalLowercaseString(legacyPluginId);
            if (normalizedLegacyPluginId) {
                lookup.set(normalizedLegacyPluginId, plugin.id);
            }
        }
    }
    for (const [alias, pluginId] of BUILT_IN_PLUGIN_ALIAS_FALLBACKS) {
        lookup.set(alias, pluginId);
    }
    bundledPluginAliasLookupCache = lookup;
    return lookup;
}
export function normalizePluginId(id) {
    const trimmed = normalizeOptionalString(id) ?? "";
    const normalized = normalizeOptionalLowercaseString(trimmed) ?? "";
    const builtInAlias = BUILT_IN_PLUGIN_ALIAS_LOOKUP.get(normalized);
    if (builtInAlias) {
        return builtInAlias;
    }
    return getBundledPluginAliasLookup().get(normalized) ?? trimmed;
}
export const normalizePluginsConfig = (config) => {
    return normalizePluginsConfigWithResolver(config, normalizePluginId);
};
export function createPluginActivationSource(params) {
    return {
        plugins: params.plugins ?? normalizePluginsConfig(params.config?.plugins),
        rootConfig: params.config,
    };
}
const hasExplicitMemorySlot = (plugins) => Boolean(plugins?.slots && Object.prototype.hasOwnProperty.call(plugins.slots, "memory"));
const hasExplicitMemoryEntry = (plugins) => Boolean(plugins?.entries &&
    Object.prototype.hasOwnProperty.call(plugins.entries, defaultSlotIdForKey("memory")));
export const hasExplicitPluginConfig = (plugins) => hasExplicitPluginConfigShared(plugins);
export function applyTestPluginDefaults(cfg, env = process.env) {
    if (!env.VITEST) {
        return cfg;
    }
    const plugins = cfg.plugins;
    const explicitConfig = hasExplicitPluginConfig(plugins);
    if (explicitConfig) {
        if (hasExplicitMemorySlot(plugins) || hasExplicitMemoryEntry(plugins)) {
            return cfg;
        }
        return {
            ...cfg,
            plugins: {
                ...plugins,
                slots: {
                    ...plugins?.slots,
                    memory: "none",
                },
            },
        };
    }
    return {
        ...cfg,
        plugins: {
            ...plugins,
            enabled: false,
            slots: {
                ...plugins?.slots,
                memory: "none",
            },
        },
    };
}
export function isTestDefaultMemorySlotDisabled(cfg, env = process.env) {
    if (!env.VITEST) {
        return false;
    }
    const plugins = cfg.plugins;
    if (hasExplicitMemorySlot(plugins) || hasExplicitMemoryEntry(plugins)) {
        return false;
    }
    return true;
}
export function resolvePluginActivationState(params) {
    return toPluginActivationState(resolvePluginActivationDecisionShared({
        ...params,
        activationSource: params.activationSource ??
            createPluginActivationSource({
                config: params.rootConfig,
                plugins: params.config,
            }),
        allowBundledChannelExplicitBypassesAllowlist: true,
        isBundledChannelEnabledByChannelConfig,
    }));
}
export const resolveEnableState = createPluginEnableStateResolver(resolvePluginActivationState);
export const isBundledChannelEnabledByChannelConfig = isBundledChannelEnabledByChannelConfigShared;
export const resolveEffectiveEnableState = createEffectiveEnableStateResolver(resolveEffectivePluginActivationState);
export function resolveEffectivePluginActivationState(params) {
    return resolvePluginActivationState(params);
}
export function resolveMemorySlotDecision(params) {
    return resolveMemorySlotDecisionShared(params);
}
