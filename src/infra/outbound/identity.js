import { resolveAgentAvatar } from "../../agents/identity-avatar.js";
import { resolveAgentIdentity } from "../../agents/identity.js";
export function normalizeOutboundIdentity(identity) {
    if (!identity) {
        return undefined;
    }
    const name = identity.name?.trim() || undefined;
    const avatarUrl = identity.avatarUrl?.trim() || undefined;
    const emoji = identity.emoji?.trim() || undefined;
    if (!name && !avatarUrl && !emoji) {
        return undefined;
    }
    return { name, avatarUrl, emoji };
}
export function resolveAgentOutboundIdentity(cfg, agentId) {
    const agentIdentity = resolveAgentIdentity(cfg, agentId);
    const avatar = resolveAgentAvatar(cfg, agentId);
    return normalizeOutboundIdentity({
        name: agentIdentity?.name,
        emoji: agentIdentity?.emoji,
        avatarUrl: avatar.kind === "remote" ? avatar.url : undefined,
    });
}
