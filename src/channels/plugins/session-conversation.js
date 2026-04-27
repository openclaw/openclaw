import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { tryLoadActivatedBundledPluginPublicSurfaceModuleSync } from "../../plugin-sdk/facade-runtime.js";
import { getActivePluginChannelRegistryVersion } from "../../plugins/runtime.js";
import { parseRawSessionConversationRef, parseThreadSessionSuffix, } from "../../sessions/session-key-utils.js";
import { normalizeOptionalLowercaseString, normalizeOptionalString, } from "../../shared/string-coerce.js";
import { normalizeChannelId as normalizeChatChannelId } from "../registry.js";
import { getLoadedChannelPlugin, normalizeChannelId as normalizeAnyChannelId } from "./registry.js";
const SESSION_KEY_API_ARTIFACT_BASENAME = "session-key-api.js";
const bundledSessionConversationFallbackCache = new Map();
function normalizeResolvedChannel(channel) {
    return (normalizeAnyChannelId(channel) ??
        normalizeChatChannelId(channel) ??
        normalizeOptionalLowercaseString(channel) ??
        "");
}
function getMessagingAdapter(channel) {
    const normalizedChannel = normalizeResolvedChannel(channel);
    try {
        return getLoadedChannelPlugin(normalizedChannel)?.messaging;
    }
    catch {
        return undefined;
    }
}
function dedupeConversationIds(values) {
    const seen = new Set();
    const resolved = [];
    for (const value of values) {
        if (typeof value !== "string") {
            continue;
        }
        const trimmed = value.trim();
        if (!trimmed || seen.has(trimmed)) {
            continue;
        }
        seen.add(trimmed);
        resolved.push(trimmed);
    }
    return resolved;
}
function buildGenericConversationResolution(rawId) {
    const trimmed = rawId.trim();
    if (!trimmed) {
        return null;
    }
    const parsed = parseThreadSessionSuffix(trimmed);
    const id = (parsed.baseSessionKey ?? trimmed).trim();
    if (!id) {
        return null;
    }
    return {
        id,
        threadId: parsed.threadId,
        baseConversationId: id,
        parentConversationCandidates: dedupeConversationIds(parsed.threadId ? [parsed.baseSessionKey] : []),
    };
}
function normalizeSessionConversationResolution(resolved) {
    if (!resolved?.id?.trim()) {
        return null;
    }
    return {
        id: resolved.id.trim(),
        threadId: normalizeOptionalString(resolved.threadId),
        baseConversationId: normalizeOptionalString(resolved.baseConversationId) ??
            dedupeConversationIds(resolved.parentConversationCandidates ?? []).at(-1) ??
            resolved.id.trim(),
        parentConversationCandidates: dedupeConversationIds(resolved.parentConversationCandidates ?? []),
        hasExplicitParentConversationCandidates: Object.hasOwn(resolved, "parentConversationCandidates"),
    };
}
function resolveBundledSessionConversationFallback(params) {
    if (isBundledSessionConversationFallbackDisabled(params.channel)) {
        return null;
    }
    const dirName = normalizeResolvedChannel(params.channel);
    const version = getActivePluginChannelRegistryVersion();
    let cached = bundledSessionConversationFallbackCache.get(dirName);
    if (!cached || cached.version !== version) {
        let resolveSessionConversation = null;
        try {
            const loaded = tryLoadActivatedBundledPluginPublicSurfaceModuleSync({
                dirName,
                artifactBasename: SESSION_KEY_API_ARTIFACT_BASENAME,
            });
            resolveSessionConversation =
                typeof loaded?.resolveSessionConversation === "function"
                    ? loaded.resolveSessionConversation
                    : null;
        }
        catch {
            resolveSessionConversation = null;
        }
        cached = {
            version,
            resolveSessionConversation,
        };
        bundledSessionConversationFallbackCache.set(dirName, cached);
    }
    if (typeof cached.resolveSessionConversation !== "function") {
        return null;
    }
    return normalizeSessionConversationResolution(cached.resolveSessionConversation({
        kind: params.kind,
        rawId: params.rawId,
    }));
}
function isBundledSessionConversationFallbackDisabled(channel) {
    const snapshot = getRuntimeConfigSnapshot();
    if (!snapshot?.plugins) {
        return false;
    }
    if (snapshot.plugins.enabled === false) {
        return true;
    }
    const entry = snapshot.plugins.entries?.[normalizeResolvedChannel(channel)];
    return !!entry && typeof entry === "object" && entry.enabled === false;
}
function shouldProbeBundledSessionConversationFallback(rawId) {
    return rawId.includes(":");
}
function resolveSessionConversationResolution(params) {
    const rawId = params.rawId.trim();
    if (!rawId) {
        return null;
    }
    const messaging = getMessagingAdapter(params.channel);
    const pluginResolved = normalizeSessionConversationResolution(messaging?.resolveSessionConversation?.({
        kind: params.kind,
        rawId,
    }));
    const shouldTryBundledFallback = params.bundledFallback !== false &&
        !messaging &&
        shouldProbeBundledSessionConversationFallback(rawId);
    const resolved = pluginResolved ??
        (shouldTryBundledFallback
            ? resolveBundledSessionConversationFallback({
                channel: params.channel,
                kind: params.kind,
                rawId,
            })
            : null) ??
        buildGenericConversationResolution(rawId);
    if (!resolved) {
        return null;
    }
    const parentConversationCandidates = dedupeConversationIds(pluginResolved?.hasExplicitParentConversationCandidates
        ? resolved.parentConversationCandidates
        : (messaging?.resolveParentConversationCandidates?.({
            kind: params.kind,
            rawId,
        }) ?? resolved.parentConversationCandidates));
    const baseConversationId = parentConversationCandidates.at(-1) ?? resolved.baseConversationId ?? resolved.id;
    return {
        ...resolved,
        baseConversationId,
        parentConversationCandidates,
    };
}
export function resolveSessionConversation(params) {
    return resolveSessionConversationResolution(params);
}
function buildBaseSessionKey(raw, id) {
    return `${raw.prefix}:${id}`;
}
export function resolveSessionConversationRef(sessionKey, opts = {}) {
    const raw = parseRawSessionConversationRef(sessionKey);
    if (!raw) {
        return null;
    }
    const resolved = resolveSessionConversation({
        ...raw,
        bundledFallback: opts.bundledFallback,
    });
    if (!resolved) {
        return null;
    }
    return {
        channel: normalizeResolvedChannel(raw.channel),
        kind: raw.kind,
        rawId: raw.rawId,
        id: resolved.id,
        threadId: resolved.threadId,
        baseSessionKey: buildBaseSessionKey(raw, resolved.id),
        baseConversationId: resolved.baseConversationId,
        parentConversationCandidates: resolved.parentConversationCandidates,
    };
}
export function resolveSessionThreadInfo(sessionKey, opts = {}) {
    const resolved = resolveSessionConversationRef(sessionKey, opts);
    if (!resolved) {
        return parseThreadSessionSuffix(sessionKey);
    }
    return {
        baseSessionKey: resolved.threadId
            ? resolved.baseSessionKey
            : normalizeOptionalString(sessionKey),
        threadId: resolved.threadId,
    };
}
export function resolveSessionParentSessionKey(sessionKey) {
    const { baseSessionKey, threadId } = resolveSessionThreadInfo(sessionKey);
    if (!threadId) {
        return null;
    }
    return baseSessionKey ?? null;
}
