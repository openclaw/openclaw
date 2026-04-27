import { getLoadedChannelPluginForRead } from "../../channels/plugins/registry-loaded-read.js";
import { getActivePluginChannelRegistryVersion } from "../../plugins/runtime.js";
import { normalizeOptionalLowercaseString, normalizeOptionalString, } from "../../shared/string-coerce.js";
export function normalizeChannelTargetInput(raw) {
    return raw.trim();
}
const targetNormalizerCacheByChannelId = new Map();
function resetTargetNormalizerCacheForTests() {
    targetNormalizerCacheByChannelId.clear();
}
export const __testing = {
    resetTargetNormalizerCacheForTests,
};
function resolveTargetNormalizer(channelId) {
    const version = getActivePluginChannelRegistryVersion();
    const cached = targetNormalizerCacheByChannelId.get(channelId);
    if (cached && cached.version === version) {
        return cached.normalizer;
    }
    const plugin = getLoadedChannelPluginForRead(channelId);
    const normalizer = plugin?.messaging?.normalizeTarget;
    targetNormalizerCacheByChannelId.set(channelId, {
        version,
        normalizer,
    });
    return normalizer;
}
export function normalizeTargetForProvider(provider, raw) {
    if (!raw) {
        return undefined;
    }
    const fallback = normalizeOptionalString(raw);
    if (!fallback) {
        return undefined;
    }
    const providerId = normalizeOptionalLowercaseString(provider);
    const normalizer = providerId ? resolveTargetNormalizer(providerId) : undefined;
    return normalizeOptionalString(normalizer?.(raw) ?? fallback);
}
export function resolveNormalizedTargetInput(provider, raw) {
    const trimmed = normalizeChannelTargetInput(raw ?? "");
    if (!trimmed) {
        return undefined;
    }
    return {
        raw: trimmed,
        normalized: normalizeTargetForProvider(provider, trimmed) ?? trimmed,
    };
}
export function looksLikeTargetId(params) {
    const normalizedInput = params.normalized ?? normalizeTargetForProvider(params.channel, params.raw);
    const lookup = getLoadedChannelPluginForRead(params.channel)?.messaging?.targetResolver
        ?.looksLikeId;
    if (lookup) {
        return lookup(params.raw, normalizedInput ?? params.raw);
    }
    if (/^(channel|group|user):/i.test(params.raw)) {
        return true;
    }
    if (/^[@#]/.test(params.raw)) {
        return true;
    }
    if (/^\+?\d{6,}$/.test(params.raw)) {
        return true;
    }
    if (params.raw.includes("@thread")) {
        return true;
    }
    return /^(conversation|user):/i.test(params.raw);
}
export async function maybeResolvePluginMessagingTarget(params) {
    const normalizedInput = resolveNormalizedTargetInput(params.channel, params.input);
    if (!normalizedInput) {
        return undefined;
    }
    const resolver = getLoadedChannelPluginForRead(params.channel)?.messaging?.targetResolver;
    if (!resolver?.resolveTarget) {
        return undefined;
    }
    if (params.requireIdLike &&
        !looksLikeTargetId({
            channel: params.channel,
            raw: normalizedInput.raw,
            normalized: normalizedInput.normalized,
        })) {
        return undefined;
    }
    const resolved = await resolver.resolveTarget({
        cfg: params.cfg,
        accountId: params.accountId,
        input: normalizedInput.raw,
        normalized: normalizedInput.normalized,
        preferredKind: params.preferredKind,
    });
    if (!resolved) {
        return undefined;
    }
    return {
        to: resolved.to,
        kind: resolved.kind,
        display: resolved.display,
        source: resolved.source ?? "normalized",
    };
}
export function buildTargetResolverSignature(channel) {
    const plugin = getLoadedChannelPluginForRead(channel);
    const resolver = plugin?.messaging?.targetResolver;
    const hint = resolver?.hint ?? "";
    const looksLike = resolver?.looksLikeId;
    const source = looksLike ? looksLike.toString() : "";
    return hashSignature(`${hint}|${source}`);
}
function hashSignature(value) {
    let hash = 5381;
    for (let i = 0; i < value.length; i += 1) {
        hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
    }
    return (hash >>> 0).toString(36);
}
