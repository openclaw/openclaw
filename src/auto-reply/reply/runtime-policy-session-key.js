import { normalizeChatType } from "../../channels/chat-type.js";
import { buildAgentMainSessionKey, buildAgentPeerSessionKey, normalizeAgentId, normalizeMainKey, resolveAgentIdFromSessionKey, } from "../../routing/session-key.js";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString, } from "../../shared/string-coerce.js";
function resolvePolicyChannel(ctx) {
    const raw = normalizeOptionalString(ctx?.OriginatingChannel ?? ctx?.Provider ?? ctx?.Surface);
    if (!raw) {
        return undefined;
    }
    const channel = normalizeLowercaseStringOrEmpty(raw);
    return channel && channel !== "webchat" ? channel : undefined;
}
function resolvePolicyDirectPeerId(ctx) {
    return normalizeOptionalString(ctx?.NativeDirectUserId ??
        ctx?.SenderId ??
        ctx?.SenderE164 ??
        ctx?.SenderUsername ??
        ctx?.OriginatingTo ??
        ctx?.From ??
        ctx?.To);
}
function isMainSessionAlias(params) {
    const raw = normalizeLowercaseStringOrEmpty(params.sessionKey);
    if (!raw) {
        return false;
    }
    const agentId = normalizeAgentId(params.agentId);
    const mainKey = normalizeMainKey(params.cfg?.session?.mainKey);
    const agentMainSessionKey = buildAgentMainSessionKey({
        agentId,
        mainKey,
    });
    const agentMainAliasKey = buildAgentMainSessionKey({
        agentId,
        mainKey: "main",
    });
    return (raw === "main" ||
        raw === mainKey ||
        raw === agentMainSessionKey ||
        raw === agentMainAliasKey ||
        raw === buildAgentMainSessionKey({ agentId: "main", mainKey }) ||
        raw === buildAgentMainSessionKey({ agentId: "main", mainKey: "main" }) ||
        (params.cfg?.session?.scope === "global" && raw === "global"));
}
export function resolveRuntimePolicySessionKey(params) {
    const explicitPolicySessionKey = normalizeOptionalString(params.ctx?.RuntimePolicySessionKey);
    if (explicitPolicySessionKey) {
        return explicitPolicySessionKey;
    }
    const sessionKey = normalizeOptionalString(params.sessionKey ?? params.ctx?.CommandTargetSessionKey ?? params.ctx?.SessionKey);
    if (!sessionKey) {
        return undefined;
    }
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    if (!isMainSessionAlias({ cfg: params.cfg, agentId, sessionKey })) {
        return sessionKey;
    }
    if (normalizeChatType(params.ctx?.ChatType) !== "direct") {
        return sessionKey;
    }
    const channel = resolvePolicyChannel(params.ctx);
    const peerId = resolvePolicyDirectPeerId(params.ctx);
    if (!channel || !peerId) {
        return sessionKey;
    }
    return buildAgentPeerSessionKey({
        agentId,
        channel,
        accountId: params.ctx?.AccountId,
        peerKind: "direct",
        peerId,
        dmScope: "per-account-channel-peer",
        identityLinks: params.cfg?.session?.identityLinks,
    });
}
