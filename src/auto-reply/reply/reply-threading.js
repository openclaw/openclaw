import { getChannelPlugin } from "../../channels/plugins/index.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { isSingleUseReplyToMode } from "./reply-reference.js";
function normalizeReplyToModeChatType(chatType) {
    return chatType === "direct" || chatType === "group" || chatType === "channel"
        ? chatType
        : undefined;
}
export function resolveConfiguredReplyToMode(cfg, channel, chatType) {
    const provider = normalizeAnyChannelId(channel) ?? normalizeOptionalLowercaseString(channel);
    if (!provider) {
        return "all";
    }
    const channelConfig = cfg.channels?.[provider];
    const normalizedChatType = normalizeReplyToModeChatType(chatType);
    if (normalizedChatType) {
        const scopedMode = channelConfig?.replyToModeByChatType?.[normalizedChatType];
        if (scopedMode !== undefined) {
            return scopedMode;
        }
    }
    if (normalizedChatType === "direct") {
        const legacyDirectMode = channelConfig?.dm?.replyToMode;
        if (legacyDirectMode !== undefined) {
            return legacyDirectMode;
        }
    }
    return channelConfig?.replyToMode ?? "all";
}
export function resolveReplyToModeWithThreading(cfg, threading, params = {}) {
    const resolved = threading?.resolveReplyToMode?.({
        cfg,
        accountId: params.accountId,
        chatType: params.chatType,
    });
    return resolved ?? resolveConfiguredReplyToMode(cfg, params.channel, params.chatType);
}
export function resolveReplyToMode(cfg, channel, accountId, chatType) {
    const normalizedAccountId = normalizeOptionalLowercaseString(accountId);
    if (!normalizedAccountId) {
        return resolveConfiguredReplyToMode(cfg, channel, chatType);
    }
    const provider = normalizeAnyChannelId(channel) ?? normalizeOptionalLowercaseString(channel);
    const threading = provider ? getChannelPlugin(provider)?.threading : undefined;
    return resolveReplyToModeWithThreading(cfg, threading, {
        channel,
        accountId: normalizedAccountId,
        chatType,
    });
}
export function createReplyToModeFilter(mode, opts = {}) {
    let hasThreaded = false;
    return (payload) => {
        if (!payload.replyToId) {
            return payload;
        }
        if (mode === "off") {
            const isExplicit = Boolean(payload.replyToTag) || Boolean(payload.replyToCurrent);
            // Compaction notices must never be threaded when replyToMode=off — even
            // if they carry explicit reply tags (replyToCurrent).  Honouring the
            // explicit tag here would make status notices appear in-thread while
            // normal assistant replies stay off-thread, contradicting the off-mode
            // expectation.  Strip replyToId unconditionally for compaction payloads.
            if (opts.allowExplicitReplyTagsWhenOff && isExplicit && !payload.isCompactionNotice) {
                return payload;
            }
            return { ...payload, replyToId: undefined };
        }
        if (mode === "all") {
            return payload;
        }
        if (isSingleUseReplyToMode(mode) && hasThreaded) {
            // Compaction notices are transient status messages that should always
            // appear in-thread, even after the first assistant block has already
            // consumed the "first" slot.  Let them keep their replyToId.
            if (payload.isCompactionNotice) {
                return payload;
            }
            return { ...payload, replyToId: undefined };
        }
        // Compaction notices are transient status messages — they should be
        // threaded (so they appear in-context), but they must not consume the
        // "first" slot of the replyToMode=first|batched filter.  Skip advancing
        // hasThreaded so the real assistant reply still gets replyToId.
        if (isSingleUseReplyToMode(mode) && !payload.isCompactionNotice) {
            hasThreaded = true;
        }
        return payload;
    };
}
export function resolveImplicitCurrentMessageReplyAllowance(mode, policy) {
    const implicitCurrentMessage = policy?.implicitCurrentMessage ?? "default";
    if (implicitCurrentMessage === "allow") {
        return true;
    }
    if (implicitCurrentMessage === "deny") {
        return false;
    }
    return mode !== "batched";
}
export function resolveBatchedReplyThreadingPolicy(mode, isBatched) {
    if (mode !== "batched") {
        return undefined;
    }
    return {
        implicitCurrentMessage: isBatched ? "allow" : "deny",
    };
}
export function createReplyToModeFilterForChannel(mode, channel) {
    const normalized = normalizeOptionalLowercaseString(channel);
    const isWebchat = normalized === "webchat";
    // Default: allow explicit reply tags/directives even when replyToMode is "off".
    // Unknown channels fail closed; internal webchat stays allowed.
    const allowExplicitReplyTagsWhenOff = normalized ? true : isWebchat;
    return createReplyToModeFilter(mode, {
        allowExplicitReplyTagsWhenOff,
    });
}
