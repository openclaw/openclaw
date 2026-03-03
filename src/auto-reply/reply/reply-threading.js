import { getChannelDock } from "../../channels/dock.js";
import { normalizeChannelId } from "../../channels/plugins/index.js";
export function resolveReplyToMode(cfg, channel, accountId, chatType) {
    const provider = normalizeChannelId(channel);
    if (!provider) {
        return "all";
    }
    const resolved = getChannelDock(provider)?.threading?.resolveReplyToMode?.({
        cfg,
        accountId,
        chatType,
    });
    return resolved ?? "all";
}
export function createReplyToModeFilter(mode, opts = {}) {
    let hasThreaded = false;
    return (payload) => {
        if (!payload.replyToId) {
            return payload;
        }
        if (mode === "off") {
            const isExplicit = Boolean(payload.replyToTag) || Boolean(payload.replyToCurrent);
            if (opts.allowExplicitReplyTagsWhenOff && isExplicit) {
                return payload;
            }
            return { ...payload, replyToId: undefined };
        }
        if (mode === "all") {
            return payload;
        }
        if (hasThreaded) {
            return { ...payload, replyToId: undefined };
        }
        hasThreaded = true;
        return payload;
    };
}
export function createReplyToModeFilterForChannel(mode, channel) {
    const provider = normalizeChannelId(channel);
    const normalized = typeof channel === "string" ? channel.trim().toLowerCase() : undefined;
    const isWebchat = normalized === "webchat";
    // Default: allow explicit reply tags/directives even when replyToMode is "off".
    // Unknown channels fail closed; internal webchat stays allowed.
    const dock = provider ? getChannelDock(provider) : undefined;
    const allowExplicitReplyTagsWhenOff = provider
        ? (dock?.threading?.allowExplicitReplyTagsWhenOff ?? dock?.threading?.allowTagsWhenOff ?? true)
        : isWebchat;
    return createReplyToModeFilter(mode, {
        allowExplicitReplyTagsWhenOff,
    });
}
