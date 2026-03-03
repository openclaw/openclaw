import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export const DEFAULT_TALK_PROVIDER = "elevenlabs";
function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeString(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
function normalizeVoiceAliases(value) {
    if (!isPlainObject(value)) {
        return undefined;
    }
    const aliases = {};
    for (const [alias, rawId] of Object.entries(value)) {
        if (typeof rawId !== "string") {
            continue;
        }
        aliases[alias] = rawId;
    }
    return Object.keys(aliases).length > 0 ? aliases : undefined;
}
function normalizeTalkProviderConfig(value) {
    if (!isPlainObject(value)) {
        return undefined;
    }
    const provider = {};
    for (const [key, raw] of Object.entries(value)) {
        if (raw === undefined) {
            continue;
        }
        if (key === "voiceAliases") {
            const aliases = normalizeVoiceAliases(raw);
            if (aliases) {
                provider.voiceAliases = aliases;
            }
            continue;
        }
        if (key === "voiceId" || key === "modelId" || key === "outputFormat" || key === "apiKey") {
            const normalized = normalizeString(raw);
            if (normalized) {
                provider[key] = normalized;
            }
            continue;
        }
        provider[key] = raw;
    }
    return Object.keys(provider).length > 0 ? provider : undefined;
}
function normalizeTalkProviders(value) {
    if (!isPlainObject(value)) {
        return undefined;
    }
    const providers = {};
    for (const [rawProviderId, providerConfig] of Object.entries(value)) {
        const providerId = normalizeString(rawProviderId);
        if (!providerId) {
            continue;
        }
        const normalizedProvider = normalizeTalkProviderConfig(providerConfig);
        if (!normalizedProvider) {
            continue;
        }
        providers[providerId] = normalizedProvider;
    }
    return Object.keys(providers).length > 0 ? providers : undefined;
}
function normalizedLegacyTalkFields(source) {
    const legacy = {};
    const voiceId = normalizeString(source.voiceId);
    if (voiceId) {
        legacy.voiceId = voiceId;
    }
    const voiceAliases = normalizeVoiceAliases(source.voiceAliases);
    if (voiceAliases) {
        legacy.voiceAliases = voiceAliases;
    }
    const modelId = normalizeString(source.modelId);
    if (modelId) {
        legacy.modelId = modelId;
    }
    const outputFormat = normalizeString(source.outputFormat);
    if (outputFormat) {
        legacy.outputFormat = outputFormat;
    }
    const apiKey = normalizeString(source.apiKey);
    if (apiKey) {
        legacy.apiKey = apiKey;
    }
    return legacy;
}
function legacyProviderConfigFromTalk(source) {
    return normalizeTalkProviderConfig({
        voiceId: source.voiceId,
        voiceAliases: source.voiceAliases,
        modelId: source.modelId,
        outputFormat: source.outputFormat,
        apiKey: source.apiKey,
    });
}
function activeProviderFromTalk(talk) {
    const provider = normalizeString(talk.provider);
    if (provider) {
        return provider;
    }
    const providerIds = talk.providers ? Object.keys(talk.providers) : [];
    return providerIds.length === 1 ? providerIds[0] : undefined;
}
function legacyTalkFieldsFromProviderConfig(config) {
    if (!config) {
        return {};
    }
    const legacy = {};
    if (typeof config.voiceId === "string") {
        legacy.voiceId = config.voiceId;
    }
    if (config.voiceAliases &&
        typeof config.voiceAliases === "object" &&
        !Array.isArray(config.voiceAliases)) {
        const aliases = normalizeVoiceAliases(config.voiceAliases);
        if (aliases) {
            legacy.voiceAliases = aliases;
        }
    }
    if (typeof config.modelId === "string") {
        legacy.modelId = config.modelId;
    }
    if (typeof config.outputFormat === "string") {
        legacy.outputFormat = config.outputFormat;
    }
    if (typeof config.apiKey === "string") {
        legacy.apiKey = config.apiKey;
    }
    return legacy;
}
export function normalizeTalkSection(value) {
    if (!isPlainObject(value)) {
        return undefined;
    }
    const source = value;
    const hasNormalizedShape = typeof source.provider === "string" || isPlainObject(source.providers);
    const normalized = {};
    const legacy = normalizedLegacyTalkFields(source);
    if (Object.keys(legacy).length > 0) {
        Object.assign(normalized, legacy);
    }
    if (typeof source.interruptOnSpeech === "boolean") {
        normalized.interruptOnSpeech = source.interruptOnSpeech;
    }
    if (hasNormalizedShape) {
        const providers = normalizeTalkProviders(source.providers);
        const provider = normalizeString(source.provider);
        if (providers) {
            normalized.providers = providers;
        }
        if (provider) {
            normalized.provider = provider;
        }
        else if (providers) {
            const ids = Object.keys(providers);
            if (ids.length === 1) {
                normalized.provider = ids[0];
            }
        }
        return Object.keys(normalized).length > 0 ? normalized : undefined;
    }
    const legacyProviderConfig = legacyProviderConfigFromTalk(source);
    if (legacyProviderConfig) {
        normalized.provider = DEFAULT_TALK_PROVIDER;
        normalized.providers = { [DEFAULT_TALK_PROVIDER]: legacyProviderConfig };
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
}
export function normalizeTalkConfig(config) {
    if (!config.talk) {
        return config;
    }
    const normalizedTalk = normalizeTalkSection(config.talk);
    if (!normalizedTalk) {
        return config;
    }
    return {
        ...config,
        talk: normalizedTalk,
    };
}
export function resolveActiveTalkProviderConfig(talk) {
    const normalizedTalk = normalizeTalkSection(talk);
    if (!normalizedTalk) {
        return {};
    }
    const provider = activeProviderFromTalk(normalizedTalk);
    if (!provider) {
        return {};
    }
    return {
        provider,
        config: normalizedTalk.providers?.[provider],
    };
}
export function buildTalkConfigResponse(value) {
    if (!isPlainObject(value)) {
        return undefined;
    }
    const normalized = normalizeTalkSection(value);
    if (!normalized) {
        return undefined;
    }
    const payload = {};
    if (typeof normalized.interruptOnSpeech === "boolean") {
        payload.interruptOnSpeech = normalized.interruptOnSpeech;
    }
    if (normalized.providers && Object.keys(normalized.providers).length > 0) {
        payload.providers = normalized.providers;
    }
    if (typeof normalized.provider === "string") {
        payload.provider = normalized.provider;
    }
    const activeProvider = activeProviderFromTalk(normalized);
    const providerConfig = activeProvider ? normalized.providers?.[activeProvider] : undefined;
    const providerCompatibilityLegacy = legacyTalkFieldsFromProviderConfig(providerConfig);
    const compatibilityLegacy = Object.keys(providerCompatibilityLegacy).length > 0
        ? providerCompatibilityLegacy
        : normalizedLegacyTalkFields(normalized);
    Object.assign(payload, compatibilityLegacy);
    return Object.keys(payload).length > 0 ? payload : undefined;
}
export function readTalkApiKeyFromProfile(deps = {}) {
    const fsImpl = deps.fs ?? fs;
    const osImpl = deps.os ?? os;
    const pathImpl = deps.path ?? path;
    const home = osImpl.homedir();
    const candidates = [".profile", ".zprofile", ".zshrc", ".bashrc"].map((name) => pathImpl.join(home, name));
    for (const candidate of candidates) {
        if (!fsImpl.existsSync(candidate)) {
            continue;
        }
        try {
            const text = fsImpl.readFileSync(candidate, "utf-8");
            const match = text.match(/(?:^|\n)\s*(?:export\s+)?ELEVENLABS_API_KEY\s*=\s*["']?([^\n"']+)["']?/);
            const value = match?.[1]?.trim();
            if (value) {
                return value;
            }
        }
        catch {
            // Ignore profile read errors.
        }
    }
    return null;
}
export function resolveTalkApiKey(env = process.env, deps = {}) {
    const envValue = (env.ELEVENLABS_API_KEY ?? "").trim();
    if (envValue) {
        return envValue;
    }
    return readTalkApiKeyFromProfile(deps);
}
