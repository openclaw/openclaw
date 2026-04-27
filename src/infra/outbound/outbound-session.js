import { getChannelPlugin } from "../../channels/plugins/index.js";
import { recordSessionMetaFromInbound, resolveStorePath, } from "../../config/sessions/inbound.runtime.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { buildOutboundBaseSessionKey } from "./base-session-key.js";
function resolveOutboundChannelPlugin(channel) {
    return getChannelPlugin(channel);
}
function stripProviderPrefix(raw, channel) {
    const trimmed = raw.trim();
    const lower = normalizeLowercaseStringOrEmpty(trimmed);
    const prefix = `${normalizeLowercaseStringOrEmpty(channel)}:`;
    if (lower.startsWith(prefix)) {
        return trimmed.slice(prefix.length).trim();
    }
    return trimmed;
}
function stripKindPrefix(raw) {
    return raw.replace(/^(user|channel|group|conversation|room|dm):/i, "").trim();
}
function inferPeerKind(params) {
    const resolvedKind = params.resolvedTarget?.kind;
    if (resolvedKind === "user") {
        return "direct";
    }
    if (resolvedKind === "channel") {
        return "channel";
    }
    if (resolvedKind === "group") {
        const plugin = resolveOutboundChannelPlugin(params.channel);
        const chatTypes = plugin?.capabilities?.chatTypes ?? [];
        const supportsChannel = chatTypes.includes("channel");
        const supportsGroup = chatTypes.includes("group");
        if (supportsChannel && !supportsGroup) {
            return "channel";
        }
        return "group";
    }
    return "direct";
}
function resolveFallbackSession(params) {
    const trimmed = stripProviderPrefix(params.target, params.channel).trim();
    if (!trimmed) {
        return null;
    }
    const peerKind = inferPeerKind({
        channel: params.channel,
        resolvedTarget: params.resolvedTarget,
    });
    const peerId = stripKindPrefix(trimmed);
    if (!peerId) {
        return null;
    }
    const peer = { kind: peerKind, id: peerId };
    const baseSessionKey = buildOutboundBaseSessionKey({
        cfg: params.cfg,
        agentId: params.agentId,
        channel: params.channel,
        accountId: params.accountId,
        peer,
    });
    const chatType = peerKind === "direct" ? "direct" : peerKind === "channel" ? "channel" : "group";
    const from = peerKind === "direct"
        ? `${params.channel}:${peerId}`
        : `${params.channel}:${peerKind}:${peerId}`;
    const toPrefix = peerKind === "direct" ? "user" : "channel";
    return {
        sessionKey: baseSessionKey,
        baseSessionKey,
        peer,
        chatType,
        from,
        to: `${toPrefix}:${peerId}`,
    };
}
export async function resolveOutboundSessionRoute(params) {
    const target = params.target.trim();
    if (!target) {
        return null;
    }
    const nextParams = { ...params, target };
    const resolver = resolveOutboundChannelPlugin(params.channel)?.messaging
        ?.resolveOutboundSessionRoute;
    if (resolver) {
        return await resolver(nextParams);
    }
    return resolveFallbackSession(nextParams);
}
export async function ensureOutboundSessionEntry(params) {
    const storePath = resolveStorePath(params.cfg.session?.store, {
        agentId: resolveAgentIdFromSessionKey(params.route.sessionKey),
    });
    const ctx = {
        From: params.route.from,
        To: params.route.to,
        SessionKey: params.route.sessionKey,
        AccountId: params.accountId ?? undefined,
        ChatType: params.route.chatType,
        Provider: params.channel,
        Surface: params.channel,
        MessageThreadId: params.route.threadId,
        OriginatingChannel: params.channel,
        OriginatingTo: params.route.to,
    };
    try {
        await recordSessionMetaFromInbound({
            storePath,
            sessionKey: params.route.sessionKey,
            ctx,
        });
    }
    catch {
        // Do not block outbound sends on session meta writes.
    }
}
