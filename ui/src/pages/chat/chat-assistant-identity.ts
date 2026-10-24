import { fetchAssistantIdentity } from "../../app/assistant-identity.ts";
import { isUiSelectedGlobalSessionKey } from "../../lib/sessions/session-key.ts";
import { resolveAgentIdForSession } from "./chat-avatar.ts";
import { retireChatModelSelectionOwnership } from "./chat-session.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

export async function loadPageAssistantIdentity(state: ChatPageHost) {
  if (!state.client || !state.connected) {
    return;
  }
  const client = state.client;
  const sessionKey = state.sessionKey.trim();
  const agentId = resolveAgentIdForSession(state);
  const requestVersion = ++state.assistantIdentityRequestVersion;
  try {
    const identity = await fetchAssistantIdentity(client, agentId);
    if (
      state.client !== client ||
      !state.connected ||
      state.assistantIdentityRequestVersion !== requestVersion ||
      state.sessionKey.trim() !== sessionKey ||
      resolveAgentIdForSession(state) !== agentId ||
      !identity
    ) {
      return;
    }
    if (
      state.assistantAgentId !== (identity.agentId ?? null) &&
      isUiSelectedGlobalSessionKey(state, state.sessionKey)
    ) {
      retireChatModelSelectionOwnership(state);
    }
    state.assistantName = identity.name;
    state.assistantAvatar = identity.avatar;
    state.assistantAvatarStatus = identity.avatarStatus ?? null;
    state.assistantAvatarReason = identity.avatarReason ?? null;
    state.assistantAgentId = identity.agentId ?? null;
  } catch {
    // Keep the last known identity when the Gateway cannot answer.
  }
}
