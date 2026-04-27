import { buildAgentSessionKey } from "../../routing/resolve-route.js";
export function buildOutboundBaseSessionKey(params) {
    return buildAgentSessionKey({
        agentId: params.agentId,
        channel: params.channel,
        accountId: params.accountId,
        peer: params.peer,
        dmScope: params.cfg.session?.dmScope ?? "main",
        identityLinks: params.cfg.session?.identityLinks,
    });
}
