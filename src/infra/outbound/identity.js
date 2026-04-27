import { resolveAgentAvatar } from "../../agents/identity-avatar.js";
import { resolveAgentIdentity } from "../../agents/identity.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
export function normalizeOutboundIdentity(identity) {
    if (!identity) {
        return undefined;
    }
    const name = normalizeOptionalString(identity.name);
    const avatarUrl = normalizeOptionalString(identity.avatarUrl);
    const emoji = normalizeOptionalString(identity.emoji);
    const theme = normalizeOptionalString(identity.theme);
    if (!name && !avatarUrl && !emoji && !theme) {
        return undefined;
    }
    return { name, avatarUrl, emoji, theme };
}
export function resolveAgentOutboundIdentity(cfg, agentId) {
    const agentIdentity = resolveAgentIdentity(cfg, agentId);
    const avatar = resolveAgentAvatar(cfg, agentId);
    return normalizeOutboundIdentity({
        name: agentIdentity?.name,
        emoji: agentIdentity?.emoji,
        avatarUrl: avatar.kind === "remote" ? avatar.url : undefined,
        theme: agentIdentity?.theme,
    });
}
