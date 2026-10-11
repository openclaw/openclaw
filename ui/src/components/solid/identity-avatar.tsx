import type { JSX } from "@solidjs/web";
import type { AgentAvatarPresentation } from "../agent-avatar.ts";
import "../agent-avatar.ts";

export function renderAgentIdentityAvatar(
  agent: AgentAvatarPresentation["agent"],
  className = "",
  onImageError?: () => void,
): JSX.Element {
  return (
    <openclaw-agent-avatar
      class="identity-avatar-presentation"
      prop:presentation={{ agent, className, onImageError }}
    />
  );
}
