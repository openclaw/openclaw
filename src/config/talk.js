import { normalizeOptionalString } from "../shared/string-coerce.js";
import { isRecord } from "../utils.js";
import { coerceSecretRef } from "./types.secrets.js";
function normalizeTalkSecretInput(value) {
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }
    return coerceSecretRef(value) ?? undefined;
}
function normalizeSilenceTimeoutMs(value) {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        return undefined;
    }
    return value;
}
function buildLegacyTalkProviderCompat(value) {
    const provider = {};
    for (const key of ["voiceId", "voiceAliases", "modelId", "outputFormat"]) {
        if (value[key] !== undefined) {
            provider[key] = value[key];
        }
    }
    const apiKey = normalizeTalkSecretInput(value.apiKey);
    if (apiKey !== undefined) {
        provider.apiKey = apiKey;
    }
    return Object.keys(provider).length > 0 ? provider : undefined;
}
function normalizeTalkProviderConfig(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const provider = {};
    for (const [key, raw] of Object.entries(value)) {
        if (raw === undefined) {
            continue;
        }
        if (key === "apiKey") {
            const normalized = normalizeTalkSecretInput(raw);
            if (normalized !== undefined) {
                provider.apiKey = normalized;
            }
            continue;
        }
        provider[key] = raw;
    }
    return Object.keys(provider).length > 0 ? provider : undefined;
}
function normalizeTalkProviders(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const providers = {};
    for (const [rawProviderId, providerConfig] of Object.entries(value)) {
        const providerId = normalizeOptionalString(rawProviderId);
        if (!providerId) {
            continue;
        }
        const normalizedProvider = normalizeTalkProviderConfig(providerConfig);
        if (!normalizedProvider) {
            continue;
        }
        providers[providerId] = {
            ...providers[providerId],
            ...normalizedProvider,
        };
    }
    return Object.keys(providers).length > 0 ? providers : undefined;
}
function activeProviderFromTalk(talk) {
    const provider = normalizeOptionalString(talk.provider);
    const providers = talk.providers;
    if (provider) {
        if (providers && !(provider in providers)) {
            return undefined;
        }
        return provider;
    }
    const providerIds = providers ? Object.keys(providers) : [];
    return providerIds.length === 1 ? providerIds[0] : undefined;
}
export function normalizeTalkSection(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const source = value;
    const normalized = {};
    const speechLocale = normalizeOptionalString(source.speechLocale);
    if (speechLocale) {
        normalized.speechLocale = speechLocale;
    }
    if (typeof source.interruptOnSpeech === "boolean") {
        normalized.interruptOnSpeech = source.interruptOnSpeech;
    }
    const silenceTimeoutMs = normalizeSilenceTimeoutMs(source.silenceTimeoutMs);
    if (silenceTimeoutMs !== undefined) {
        normalized.silenceTimeoutMs = silenceTimeoutMs;
    }
    const providers = normalizeTalkProviders(source.providers);
    const provider = normalizeOptionalString(source.provider);
    if (providers) {
        normalized.providers = providers;
    }
    if (provider) {
        normalized.provider = provider;
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
        return undefined;
    }
    const provider = activeProviderFromTalk(normalizedTalk);
    if (!provider) {
        return undefined;
    }
    return {
        provider,
        config: normalizedTalk.providers?.[provider] ?? {},
    };
}
export function buildTalkConfigResponse(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const normalized = normalizeTalkSection(value);
    const legacyCompat = buildLegacyTalkProviderCompat(value);
    if (!normalized && !legacyCompat) {
        return undefined;
    }
    const payload = {};
    if (typeof normalized?.interruptOnSpeech === "boolean") {
        payload.interruptOnSpeech = normalized.interruptOnSpeech;
    }
    if (typeof normalized?.silenceTimeoutMs === "number") {
        payload.silenceTimeoutMs = normalized.silenceTimeoutMs;
    }
    if (typeof normalized?.speechLocale === "string") {
        payload.speechLocale = normalized.speechLocale;
    }
    if (normalized?.providers && Object.keys(normalized.providers).length > 0) {
        payload.providers = normalized.providers;
    }
    const resolved = resolveActiveTalkProviderConfig(normalized) ??
        (legacyCompat ? { provider: "elevenlabs", config: legacyCompat } : undefined);
    const activeProvider = normalizeOptionalString(normalized?.provider) ?? resolved?.provider;
    if (activeProvider) {
        payload.provider = activeProvider;
    }
    if (resolved) {
        payload.resolved = resolved;
    }
    return Object.keys(payload).length > 0 ? payload : undefined;
}
