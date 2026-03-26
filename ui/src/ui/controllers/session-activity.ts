import type { GatewayBrowserClient } from "../gateway.ts";
import type { ChatSessionActivity } from "../types.ts";

export type SessionActivityState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  chatSessionActivity: ChatSessionActivity | null;
};

export async function loadChatSessionActivity(state: SessionActivityState) {
  if (!state.client || !state.connected) {
    state.chatSessionActivity = null;
    return;
  }
  try {
    const activity = await state.client.request<ChatSessionActivity | undefined>(
      "sessions.activity",
      {
        key: state.sessionKey,
      },
    );
    state.chatSessionActivity = activity ?? null;
  } catch {
    state.chatSessionActivity = null;
  }
}
