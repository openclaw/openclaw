import type { AgentsListResult } from "../../../api/types.ts";
import { resolveAgentTextAvatar } from "../../../lib/agents/display.ts";
import {
  resolveAgentAvatarUrl,
  resolveAssistantTextAvatar,
  resolveChatAvatarRenderUrl,
} from "../../../lib/avatar.ts";

export function resolveAssistantDisplayAvatar(props: {
  currentAgentId?: string;
  agents?: AgentsListResult["agents"];
  assistantAvatar: string | null;
  assistantAvatarUrl?: string | null;
}) {
  const id = props.currentAgentId ?? "main";
  const agent = props.agents?.find((entry) => entry.id === id);
  const avatar = resolveChatAvatarRenderUrl(props.assistantAvatarUrl, {
    identity: {
      avatar: props.assistantAvatar ?? undefined,
      avatarUrl: props.assistantAvatarUrl ?? undefined,
    },
  });
  return {
    id,
    avatar: avatar ?? (agent ? resolveAgentAvatarUrl(agent) : null),
    textAvatar:
      resolveAssistantTextAvatar(props.assistantAvatar) ??
      (agent ? resolveAgentTextAvatar(agent) : null),
  };
}
