import { normalizeSecretInputString, resolveSecretInputRef } from "../config/types.secrets.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
export function resolveWebProviderConfig(cfg, kind) {
    const webConfig = cfg?.tools?.web;
    if (!webConfig || typeof webConfig !== "object") {
        return undefined;
    }
    const toolConfig = webConfig[kind];
    if (!toolConfig || typeof toolConfig !== "object") {
        return undefined;
    }
    return toolConfig;
}
export function readWebProviderEnvValue(envVars, processEnv = process.env) {
    for (const envVar of envVars) {
        const value = normalizeSecretInput(processEnv[envVar]);
        if (value) {
            return value;
        }
    }
    return undefined;
}
export function providerRequiresCredential(provider) {
    return provider.requiresCredential !== false;
}
export function hasWebProviderEntryCredential(params) {
    if (!providerRequiresCredential(params.provider)) {
        return true;
    }
    const rawValue = params.resolveRawValue({
        provider: params.provider,
        config: params.config,
        toolConfig: params.toolConfig,
    });
    const configuredRef = resolveSecretInputRef({
        value: rawValue,
    }).ref;
    if (configuredRef && configuredRef.source !== "env") {
        return true;
    }
    const fromConfig = normalizeSecretInput(normalizeSecretInputString(rawValue));
    if (fromConfig) {
        return true;
    }
    return Boolean(params.resolveEnvValue({
        provider: params.provider,
        configuredEnvVarId: configuredRef?.source === "env" ? configuredRef.id : undefined,
    }));
}
export function resolveWebProviderDefinition(params) {
    if (!params.resolveEnabled({ toolConfig: params.toolConfig, sandboxed: params.sandboxed })) {
        return null;
    }
    const providers = params.providers.filter(Boolean);
    if (providers.length === 0) {
        return null;
    }
    const autoProviderId = params.resolveAutoProviderId({
        config: params.config,
        toolConfig: params.toolConfig,
        providers,
    });
    const providerId = params.providerId ?? params.runtimeMetadata?.selectedProvider ?? autoProviderId;
    if (!providerId) {
        return null;
    }
    const provider = providers.find((entry) => entry.id === providerId) ??
        providers.find((entry) => entry.id ===
            params.resolveFallbackProviderId?.({
                config: params.config,
                toolConfig: params.toolConfig,
                providers,
                providerId,
            }));
    if (!provider) {
        return null;
    }
    const definition = params.createTool({
        provider,
        config: params.config,
        toolConfig: params.toolConfig,
        runtimeMetadata: params.runtimeMetadata,
    });
    if (!definition) {
        return null;
    }
    return { provider, definition };
}
