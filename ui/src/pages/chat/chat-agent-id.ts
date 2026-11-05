import type { ApplicationContext } from "../../app/context.ts";
import { normalizeAgentLabel, resolveAgentTextAvatar } from "../../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../../lib/avatar.ts";
import type { AgentIdentity } from "../../lib/identity-avatar-view.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/navigation.ts";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
  resolveUiDefaultAgentId,
} from "../../lib/sessions/session-key.ts";
import type { ChatState } from "./chat-state-contract.ts";

type ChatAgentIdentityState = ChatState & {
  assistantName: string;
  assistantAvatar: string | null;
};

export function selectedGlobalEventAgentId(state: ChatState, agentId: string | null): string {
  return agentId ? normalizeAgentId(agentId) : resolveUiDefaultAgentId(state);
}

export function resolveChatAgentId(state: ChatState) {
  return normalizeAgentId(
    parseAgentSessionKey(state.sessionKey)?.agentId ??
      scopedAgentParamsForSession(state, state.sessionKey).agentId ??
      resolveUiSelectedGlobalAgentId(state),
  );
}

export function resolveChatAgentIdentity(
  state: ChatAgentIdentityState,
  context: Pick<ApplicationContext, "agents" | "agentIdentity">,
): AgentIdentity & { name: string } {
  const id = resolveChatAgentId(state);
  const roster = context.agents.state.agentsList;
  const agent = roster?.agents.find((entry) => entry.id === id);
  // The pane's conversation owns identity, including direct links and split panes.
  // Never borrow the globally selected agent while this target is loading or missing.
  const identity =
    !roster || agent
      ? (context.agentIdentity.get(id) ??
        (state.assistantAgentId === id && state.assistantName
          ? { agentId: id, name: state.assistantName, avatar: state.assistantAvatar ?? undefined }
          : undefined))
      : undefined;
  return {
    id,
    name: normalizeAgentLabel(agent ?? { id }, identity),
    avatar: resolveAgentAvatarUrl(agent ?? {}, identity),
    textAvatar: resolveAgentTextAvatar(agent ?? {}, identity),
    pending: !roster && !identity,
  };
}
