import { isMessagingToolDuplicate } from "../../agents/pi-embedded-helpers.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import { normalizeTargetForProvider } from "../../infra/outbound/target-normalization.js";
import { normalizeOptionalAccountId } from "../../routing/account-id.js";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString, } from "../../shared/string-coerce.js";
export function filterMessagingToolDuplicates(params) {
    const { payloads, sentTexts } = params;
    if (sentTexts.length === 0) {
        return payloads;
    }
    return payloads.filter((payload) => {
        if (payload.mediaUrl || payload.mediaUrls?.length) {
            return true;
        }
        return !isMessagingToolDuplicate(payload.text ?? "", sentTexts);
    });
}
export function filterMessagingToolMediaDuplicates(params) {
    const normalizeMediaForDedupe = (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
            return "";
        }
        if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith("file://")) {
            return trimmed;
        }
        try {
            const parsed = new URL(trimmed);
            if (parsed.protocol === "file:") {
                return decodeURIComponent(parsed.pathname || "");
            }
        }
        catch {
            // Keep fallback below for non-URL-like inputs.
        }
        return trimmed.replace(/^file:\/\//i, "");
    };
    const { payloads, sentMediaUrls } = params;
    if (sentMediaUrls.length === 0) {
        return payloads;
    }
    const sentSet = new Set(sentMediaUrls.map(normalizeMediaForDedupe).filter(Boolean));
    return payloads.map((payload) => {
        const mediaUrl = payload.mediaUrl;
        const mediaUrls = payload.mediaUrls;
        const stripSingle = mediaUrl && sentSet.has(normalizeMediaForDedupe(mediaUrl));
        const filteredUrls = mediaUrls?.filter((u) => !sentSet.has(normalizeMediaForDedupe(u)));
        if (!stripSingle && (!mediaUrls || filteredUrls?.length === mediaUrls.length)) {
            return payload;
        }
        return Object.assign({}, payload, {
            mediaUrl: stripSingle ? undefined : mediaUrl,
            mediaUrls: filteredUrls?.length ? filteredUrls : undefined,
        });
    });
}
function normalizeProviderForComparison(value) {
    const trimmed = normalizeOptionalString(value);
    if (!trimmed) {
        return undefined;
    }
    const lowered = normalizeLowercaseStringOrEmpty(trimmed);
    const normalizedChannel = normalizeAnyChannelId(trimmed);
    if (normalizedChannel) {
        return normalizedChannel;
    }
    return lowered;
}
function normalizeThreadIdForComparison(value) {
    const trimmed = normalizeOptionalString(value);
    if (!trimmed) {
        return undefined;
    }
    if (/^-?\d+$/.test(trimmed)) {
        return String(Number.parseInt(trimmed, 10));
    }
    return normalizeLowercaseStringOrEmpty(trimmed);
}
function resolveTargetProviderForComparison(params) {
    const targetProvider = normalizeProviderForComparison(params.targetProvider);
    if (!targetProvider || targetProvider === "message") {
        return params.currentProvider;
    }
    return targetProvider;
}
function targetsMatchForSuppression(params) {
    const pluginMatch = getChannelPlugin(params.provider)?.outbound?.targetsMatchForReplySuppression;
    if (pluginMatch) {
        return pluginMatch({
            originTarget: params.originTarget,
            targetKey: params.targetKey,
            targetThreadId: normalizeThreadIdForComparison(params.targetThreadId),
        });
    }
    return params.targetKey === params.originTarget;
}
export function shouldSuppressMessagingToolReplies(params) {
    const provider = normalizeProviderForComparison(params.messageProvider);
    if (!provider) {
        return false;
    }
    const originRawTarget = normalizeOptionalString(params.originatingTo);
    const originAccount = normalizeOptionalAccountId(params.accountId);
    const sentTargets = params.messagingToolSentTargets ?? [];
    if (sentTargets.length === 0) {
        return false;
    }
    return sentTargets.some((target) => {
        const targetProvider = resolveTargetProviderForComparison({
            currentProvider: provider,
            targetProvider: target?.provider,
        });
        if (targetProvider !== provider) {
            return false;
        }
        const targetAccount = normalizeOptionalAccountId(target.accountId);
        if (originAccount && targetAccount && originAccount !== targetAccount) {
            return false;
        }
        const targetRaw = normalizeOptionalString(target.to);
        if (originRawTarget && targetRaw === originRawTarget && !target.threadId) {
            return true;
        }
        const originTarget = normalizeTargetForProvider(provider, originRawTarget);
        if (!originTarget) {
            return false;
        }
        const targetKey = normalizeTargetForProvider(targetProvider, targetRaw);
        if (!targetKey) {
            return false;
        }
        return targetsMatchForSuppression({
            provider,
            originTarget,
            targetKey,
            targetThreadId: target.threadId,
        });
    });
}
