import { isReservedSystemAgentId } from "../../../src/system-agent/agent-id.js";
import { readCachedAvatarImageUrl, resolveAvatarImageUrl } from "./identity-avatar-loader.ts";
import {
  resolveAvatar,
  resolveAvatarInitials,
  type IdentityAvatarInput,
} from "./identity-avatar.ts";

export type IdentityAvatarView = ReturnType<typeof resolveIdentityAvatarView>;

/** Resolve one user identity consistently across the roster, profile, and chat. */
export function resolveIdentityAvatarView(identity: IdentityAvatarInput, cachedOnly = false) {
  const avatar = resolveAvatar(identity);
  const fallback = avatar.kind === "initials" ? avatar : resolveAvatarInitials(identity);
  const imageUrl =
    avatar.kind === "profile"
      ? cachedOnly
        ? readCachedAvatarImageUrl(avatar.url)
        : resolveAvatarImageUrl(avatar.url)
      : null;
  return {
    fallback,
    imageUrl,
    pending: imageUrl !== null && typeof imageUrl !== "string",
  };
}

export type AgentIdentity = {
  id: string;
  name?: string;
  avatar?: string | null;
  textAvatar?: string | null;
  pending?: boolean;
};

export function resolveAgentIdentityAvatarView(agent: AgentIdentity, cachedOnly = false) {
  const imageUrl =
    !isReservedSystemAgentId(agent.id) && agent.avatar && !agent.pending
      ? cachedOnly
        ? readCachedAvatarImageUrl(agent.avatar)
        : resolveAvatarImageUrl(agent.avatar, agent.avatar)
      : null;
  return {
    imageUrl,
    pending: agent.pending ?? imageUrl !== null,
  };
}
