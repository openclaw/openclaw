import { resolveSessionAgentId } from "../../agents/agent-scope.js";
function normalizeOptionalString(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
export function buildOutboundSessionContext(params) {
    const key = normalizeOptionalString(params.sessionKey);
    const explicitAgentId = normalizeOptionalString(params.agentId);
    const derivedAgentId = key
        ? resolveSessionAgentId({ sessionKey: key, config: params.cfg })
        : undefined;
    const agentId = explicitAgentId ?? derivedAgentId;
    if (!key && !agentId) {
        return undefined;
    }
    return {
        ...(key ? { key } : {}),
        ...(agentId ? { agentId } : {}),
    };
}
