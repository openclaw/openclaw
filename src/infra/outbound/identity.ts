import { resolveAgentAvatar } from "../../agents/identity-avatar.js";
import { resolveAgentIdentity } from "../../agents/identity.js";
import type { OpenClawConfig } from "../../config/config.js";

export type OutboundIdentity = {
  name?: string;
  avatarUrl?: string;
  emoji?: string;
};

export function normalizeOutboundIdentity(
  identity?: OutboundIdentity | null,
): OutboundIdentity | undefined {
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

export function resolveAgentOutboundIdentity(
  cfg: OpenClawConfig,
  agentId: string,
): OutboundIdentity | undefined {
  const agentIdentity = resolveAgentIdentity(cfg, agentId);
  const avatar = resolveAgentAvatar(cfg, agentId);
  return normalizeOutboundIdentity({
    name: agentIdentity?.name,
    emoji: agentIdentity?.emoji,
    avatarUrl: avatar.kind === "remote" ? avatar.url : undefined,
  });
}
