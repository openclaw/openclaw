import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
export function buildOutboundSessionContext(params) {
    const key = normalizeOptionalString(params.sessionKey);
    const policyKey = normalizeOptionalString(params.policySessionKey);
    const normalizedChatType = normalizeChatType(params.conversationType ?? undefined);
    const conversationType = normalizedChatType === "group" || normalizedChatType === "channel"
        ? "group"
        : normalizedChatType === "direct"
            ? "direct"
            : params.isGroup === true
                ? "group"
                : params.isGroup === false
                    ? "direct"
                    : undefined;
    const explicitAgentId = normalizeOptionalString(params.agentId);
    const requesterAccountId = normalizeOptionalString(params.requesterAccountId);
    const requesterSenderId = normalizeOptionalString(params.requesterSenderId);
    const requesterSenderName = normalizeOptionalString(params.requesterSenderName);
    const requesterSenderUsername = normalizeOptionalString(params.requesterSenderUsername);
    const requesterSenderE164 = normalizeOptionalString(params.requesterSenderE164);
    const derivedAgentId = key
        ? resolveSessionAgentId({ sessionKey: key, config: params.cfg })
        : undefined;
    const agentId = explicitAgentId ?? derivedAgentId;
    if (!key &&
        !policyKey &&
        !conversationType &&
        !agentId &&
        !requesterAccountId &&
        !requesterSenderId &&
        !requesterSenderName &&
        !requesterSenderUsername &&
        !requesterSenderE164) {
        return undefined;
    }
    return {
        ...(key ? { key } : {}),
        ...(policyKey ? { policyKey } : {}),
        ...(conversationType ? { conversationType } : {}),
        ...(agentId ? { agentId } : {}),
        ...(requesterAccountId ? { requesterAccountId } : {}),
        ...(requesterSenderId ? { requesterSenderId } : {}),
        ...(requesterSenderName ? { requesterSenderName } : {}),
        ...(requesterSenderUsername ? { requesterSenderUsername } : {}),
        ...(requesterSenderE164 ? { requesterSenderE164 } : {}),
    };
}
