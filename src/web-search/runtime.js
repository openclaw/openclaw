import { logVerbose } from "../globals.js";
import { resolvePluginWebSearchProviders } from "../plugins/web-search-providers.runtime.js";
import { resolveRuntimeWebSearchProviders } from "../plugins/web-search-providers.runtime.js";
import { sortWebSearchProvidersForAutoDetect } from "../plugins/web-search-providers.shared.js";
import { getActiveRuntimeWebToolsMetadata } from "../secrets/runtime-web-tools-state.js";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalLowercaseString, } from "../shared/string-coerce.js";
import { hasWebProviderEntryCredential, providerRequiresCredential, readWebProviderEnvValue, resolveWebProviderConfig, resolveWebProviderDefinition, } from "../web/provider-runtime-shared.js";
function resolveSearchConfig(cfg) {
    return resolveWebProviderConfig(cfg, "search");
}
export function resolveWebSearchEnabled(params) {
    if (typeof params.search?.enabled === "boolean") {
        return params.search.enabled;
    }
    if (params.sandboxed) {
        return true;
    }
    return true;
}
function hasEntryCredential(provider, config, search) {
    return hasWebProviderEntryCredential({
        provider,
        config,
        toolConfig: search,
        resolveRawValue: ({ provider: currentProvider, config: currentConfig }) => currentProvider.getConfiguredCredentialValue?.(currentConfig),
        resolveEnvValue: ({ provider: currentProvider, configuredEnvVarId }) => (configuredEnvVarId ? readWebProviderEnvValue([configuredEnvVarId]) : undefined) ??
            readWebProviderEnvValue(currentProvider.envVars),
    });
}
export function isWebSearchProviderConfigured(params) {
    return hasEntryCredential(params.provider, params.config, resolveSearchConfig(params.config));
}
export function listWebSearchProviders(params) {
    return resolveRuntimeWebSearchProviders({
        config: params?.config,
        bundledAllowlistCompat: true,
    });
}
export function listConfiguredWebSearchProviders(params) {
    return resolvePluginWebSearchProviders({
        config: params?.config,
        bundledAllowlistCompat: true,
    });
}
export function resolveWebSearchProviderId(params) {
    const providers = sortWebSearchProvidersForAutoDetect(params.providers ??
        resolvePluginWebSearchProviders({
            config: params.config,
            bundledAllowlistCompat: true,
            origin: "bundled",
        }));
    const raw = params.search && "provider" in params.search
        ? normalizeLowercaseStringOrEmpty(params.search.provider)
        : "";
    if (raw) {
        const explicit = providers.find((provider) => provider.id === raw);
        if (explicit) {
            return explicit.id;
        }
    }
    if (!raw) {
        let keylessFallbackProviderId = "";
        for (const provider of providers) {
            if (!providerRequiresCredential(provider)) {
                keylessFallbackProviderId ||= provider.id;
                continue;
            }
            if (!hasEntryCredential(provider, params.config, params.search)) {
                continue;
            }
            logVerbose(`web_search: no provider configured, auto-detected "${provider.id}" from available API keys`);
            return provider.id;
        }
        if (keylessFallbackProviderId) {
            logVerbose(`web_search: no provider configured and no credentials found, falling back to keyless provider "${keylessFallbackProviderId}"`);
            return keylessFallbackProviderId;
        }
    }
    return providers[0]?.id ?? "";
}
export function resolveWebSearchDefinition(options) {
    const search = resolveSearchConfig(options?.config);
    const runtimeWebSearch = options?.runtimeWebSearch ?? getActiveRuntimeWebToolsMetadata()?.search;
    const providers = sortWebSearchProvidersForAutoDetect(options?.preferRuntimeProviders
        ? resolveRuntimeWebSearchProviders({
            config: options?.config,
            bundledAllowlistCompat: true,
        })
        : resolvePluginWebSearchProviders({
            config: options?.config,
            bundledAllowlistCompat: true,
            origin: "bundled",
        }));
    return resolveWebProviderDefinition({
        config: options?.config,
        toolConfig: search,
        runtimeMetadata: runtimeWebSearch,
        sandboxed: options?.sandboxed,
        providerId: options?.providerId,
        providers,
        resolveEnabled: ({ toolConfig, sandboxed }) => resolveWebSearchEnabled({
            search: toolConfig,
            sandboxed,
        }),
        resolveAutoProviderId: ({ config, toolConfig, providers }) => resolveWebSearchProviderId({
            config,
            search: toolConfig,
            providers,
        }),
        resolveFallbackProviderId: ({ config, toolConfig, providers }) => resolveWebSearchProviderId({
            config,
            search: toolConfig,
            providers,
        }) || providers[0]?.id,
        createTool: ({ provider, config, toolConfig, runtimeMetadata }) => provider.createTool({
            config,
            searchConfig: toolConfig,
            runtimeMetadata,
        }),
    });
}
function resolveWebSearchCandidates(options) {
    const search = resolveSearchConfig(options?.config);
    const runtimeWebSearch = options?.runtimeWebSearch ?? getActiveRuntimeWebToolsMetadata()?.search;
    if (!resolveWebSearchEnabled({ search, sandboxed: options?.sandboxed })) {
        return [];
    }
    const providers = sortWebSearchProvidersForAutoDetect(options?.preferRuntimeProviders
        ? resolveRuntimeWebSearchProviders({
            config: options?.config,
            bundledAllowlistCompat: true,
        })
        : resolvePluginWebSearchProviders({
            config: options?.config,
            bundledAllowlistCompat: true,
            origin: "bundled",
        })).filter(Boolean);
    if (providers.length === 0) {
        return [];
    }
    const preferredIds = [
        options?.providerId,
        runtimeWebSearch?.selectedProvider,
        runtimeWebSearch?.providerConfigured,
        resolveWebSearchProviderId({ config: options?.config, search, providers }),
    ].filter((value, index, array) => Boolean(value) && array.indexOf(value) === index);
    const explicitProviderId = options?.providerId?.trim();
    if (explicitProviderId && !providers.some((entry) => entry.id === explicitProviderId)) {
        throw new Error(`Unknown web_search provider "${explicitProviderId}".`);
    }
    const orderedProviders = [
        ...preferredIds
            .map((id) => providers.find((entry) => entry.id === id))
            .filter((entry) => Boolean(entry)),
        ...providers.filter((entry) => !preferredIds.includes(entry.id)),
    ];
    return orderedProviders;
}
function hasExplicitWebSearchSelection(params) {
    if (params.providerId?.trim()) {
        return true;
    }
    const availableProviderIds = new Set((params.providers ?? []).map((provider) => normalizeLowercaseStringOrEmpty(provider.id)));
    const configuredProviderId = params.search && "provider" in params.search && typeof params.search.provider === "string"
        ? normalizeLowercaseStringOrEmpty(params.search.provider)
        : "";
    if (configuredProviderId && availableProviderIds.has(configuredProviderId)) {
        return true;
    }
    const runtimeConfiguredId = normalizeOptionalLowercaseString(params.runtimeWebSearch?.selectedProvider ?? params.runtimeWebSearch?.providerConfigured);
    if (params.runtimeWebSearch?.providerSource === "configured" &&
        runtimeConfiguredId &&
        availableProviderIds.has(runtimeConfiguredId)) {
        return true;
    }
    return false;
}
export async function runWebSearch(params) {
    const search = resolveSearchConfig(params.config);
    const runtimeWebSearch = params.runtimeWebSearch ?? getActiveRuntimeWebToolsMetadata()?.search;
    const candidates = resolveWebSearchCandidates({
        ...params,
        runtimeWebSearch,
        preferRuntimeProviders: params.preferRuntimeProviders ?? true,
    });
    if (candidates.length === 0) {
        throw new Error("web_search is disabled or no provider is available.");
    }
    const allowFallback = !hasExplicitWebSearchSelection({
        search,
        runtimeWebSearch,
        providerId: params.providerId,
        providers: candidates,
    });
    let lastError;
    let sawUnavailableProvider = false;
    for (const candidate of candidates) {
        try {
            const definition = candidate.createTool({
                config: params.config,
                searchConfig: search,
                runtimeMetadata: runtimeWebSearch,
            });
            if (!definition) {
                if (!allowFallback) {
                    throw new Error(`web_search provider "${candidate.id}" is not available.`);
                }
                sawUnavailableProvider = true;
                continue;
            }
            return {
                provider: candidate.id,
                result: await definition.execute(params.args),
            };
        }
        catch (error) {
            lastError = error;
            if (!allowFallback) {
                throw error;
            }
        }
    }
    if (sawUnavailableProvider && lastError === undefined) {
        throw new Error("web_search is enabled but no provider is currently available.");
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
export const __testing = {
    resolveSearchConfig,
    resolveSearchProvider: resolveWebSearchProviderId,
    resolveWebSearchProviderId,
    resolveWebSearchCandidates,
    hasExplicitWebSearchSelection,
};
