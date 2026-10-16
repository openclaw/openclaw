import type { AgentIdentity } from "../lib/identity-avatar-view.ts";
import { solidContent } from "../lit/solid-content.tsx";
import { AgentIdentityAvatar } from "./solid/identity-avatar.tsx";

export type { AgentIdentity } from "../lib/identity-avatar-view.ts";

/** Remaining Lit consumers share the native avatar's resource and event owner. */
export function renderAgentIdentityAvatar(
  agent: AgentIdentity,
  className = "",
  onImageError?: () => void,
) {
  return solidContent(AgentIdentityAvatar, { agent, class: className, onImageError });
}
