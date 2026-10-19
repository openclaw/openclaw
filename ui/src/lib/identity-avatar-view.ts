import { isReservedSystemAgentId } from "../../../src/system-agent/agent-id.js";
import { resolveAvatarImageUrl } from "./identity-avatar-loader.ts";
import {
  resolveAvatar,
  resolveAvatarInitials,
  type IdentityAvatarInput,
  type ResolvedIdentityAvatar,
} from "./identity-avatar.ts";

export type IdentityAvatarView = {
  fallback: Extract<ResolvedIdentityAvatar, { kind: "initials" }>;
  imageUrl: string | Promise<string | null> | null;
  pending: boolean;
};

/** Resolve one user identity consistently across the roster, profile, and chat. */
export function resolveIdentityAvatarView(identity: IdentityAvatarInput): IdentityAvatarView {
  const avatar = resolveAvatar(identity);
  const fallback = avatar.kind === "initials" ? avatar : resolveAvatarInitials(identity);
  const imageUrl = avatar.kind === "profile" ? resolveAvatarImageUrl(avatar.url) : null;
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

export function resolveAgentIdentityAvatarView(agent: AgentIdentity) {
  const imageUrl =
    !isReservedSystemAgentId(agent.id) && agent.avatar && !agent.pending
      ? resolveAvatarImageUrl(agent.avatar, agent.avatar)
      : null;
  return {
    imageUrl,
    pending: agent.pending ?? imageUrl !== null,
  };
}
