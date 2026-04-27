import { logVerbose } from "../globals.js";
import { resolvePluginWebFetchProviders } from "../plugins/web-fetch-providers.runtime.js";
import { sortWebFetchProvidersForAutoDetect } from "../plugins/web-fetch-providers.shared.js";
import { getActiveRuntimeWebToolsMetadata } from "../secrets/runtime-web-tools-state.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { hasWebProviderEntryCredential, providerRequiresCredential, readWebProviderEnvValue, resolveWebProviderConfig, resolveWebProviderDefinition, } from "../web/provider-runtime-shared.js";
export function resolveWebFetchEnabled(params) {
    if (typeof params.fetch?.enabled === "boolean") {
        return params.fetch.enabled;
    }
    return true;
}
function resolveFetchConfig(config) {
    return resolveWebProviderConfig(config, "fetch");
}
function hasEntryCredential(provider, config, fetch) {
    return hasWebProviderEntryCredential({
        provider,
        config,
        toolConfig: fetch,
        resolveRawValue: ({ provider: currentProvider, config: currentConfig, toolConfig }) => currentProvider.getConfiguredCredentialValue?.(currentConfig) ??
            currentProvider.getCredentialValue(toolConfig),
        resolveEnvValue: ({ provider: currentProvider }) => readWebProviderEnvValue(currentProvider.envVars),
    });
}
export function isWebFetchProviderConfigured(params) {
    return hasEntryCredential(params.provider, params.config, resolveFetchConfig(params.config));
}
export function listWebFetchProviders(params) {
    return resolvePluginWebFetchProviders({
        config: params?.config,
        bundledAllowlistCompat: true,
        origin: "bundled",
    });
}
export function listConfiguredWebFetchProviders(params) {
    return resolvePluginWebFetchProviders({
        config: params?.config,
        bundledAllowlistCompat: true,
    });
}
export function resolveWebFetchProviderId(params) {
    const providers = sortWebFetchProvidersForAutoDetect(params.providers ??
        resolvePluginWebFetchProviders({
            config: params.config,
            bundledAllowlistCompat: true,
            origin: "bundled",
        }));
    const raw = params.fetch && "provider" in params.fetch
        ? normalizeLowercaseStringOrEmpty(params.fetch.provider)
        : "";
    if (raw) {
        const explicit = providers.find((provider) => provider.id === raw);
        if (explicit) {
            return explicit.id;
        }
    }
    for (const provider of providers) {
        if (!providerRequiresCredential(provider)) {
            logVerbose(`web_fetch: ${raw ? `invalid configured provider "${raw}", ` : ""}auto-detected keyless provider "${provider.id}"`);
            return provider.id;
        }
        if (!hasEntryCredential(provider, params.config, params.fetch)) {
            continue;
        }
        logVerbose(`web_fetch: ${raw ? `invalid configured provider "${raw}", ` : ""}auto-detected "${provider.id}" from available API keys`);
        return provider.id;
    }
    return "";
}
export function resolveWebFetchDefinition(options) {
    const fetch = resolveWebProviderConfig(options?.config, "fetch");
    const runtimeWebFetch = options?.runtimeWebFetch ?? getActiveRuntimeWebToolsMetadata()?.fetch;
    const providers = sortWebFetchProvidersForAutoDetect(resolvePluginWebFetchProviders({
        config: options?.config,
        bundledAllowlistCompat: true,
        origin: "bundled",
    }));
    return resolveWebProviderDefinition({
        config: options?.config,
        toolConfig: fetch,
        runtimeMetadata: runtimeWebFetch,
        sandboxed: options?.sandboxed,
        providerId: options?.providerId,
        providers,
        resolveEnabled: ({ toolConfig, sandboxed }) => resolveWebFetchEnabled({
            fetch: toolConfig,
            sandboxed,
        }),
        resolveAutoProviderId: ({ config, toolConfig, providers }) => resolveWebFetchProviderId({
            config,
            fetch: toolConfig,
            providers,
        }),
        createTool: ({ provider, config, toolConfig, runtimeMetadata }) => provider.createTool({
            config,
            fetchConfig: toolConfig,
            runtimeMetadata,
        }),
    });
}
