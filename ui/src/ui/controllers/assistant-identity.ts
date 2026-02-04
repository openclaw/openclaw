<<<<<<< HEAD
import type { GatewayBrowserClient } from "../gateway";
import { normalizeAssistantIdentity, type AssistantIdentity } from "../assistant-identity";
=======
import type { GatewayBrowserClient } from "../gateway.ts";
import { normalizeAssistantIdentity } from "../assistant-identity.ts";
>>>>>>> upstream/main

export type AssistantIdentityState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAgentId: string | null;
};

export async function loadAssistantIdentity(
  state: AssistantIdentityState,
  opts?: { sessionKey?: string },
) {
<<<<<<< HEAD
  if (!state.client || !state.connected) return;
  const sessionKey = opts?.sessionKey?.trim() || state.sessionKey.trim();
  const params = sessionKey ? { sessionKey } : {};
  try {
    const res = (await state.client.request("agent.identity.get", params)) as
      | Partial<AssistantIdentity>
      | undefined;
    if (!res) return;
=======
  if (!state.client || !state.connected) {
    return;
  }
  const sessionKey = opts?.sessionKey?.trim() || state.sessionKey.trim();
  const params = sessionKey ? { sessionKey } : {};
  try {
    const res = await state.client.request("agent.identity.get", params);
    if (!res) {
      return;
    }
>>>>>>> upstream/main
    const normalized = normalizeAssistantIdentity(res);
    state.assistantName = normalized.name;
    state.assistantAvatar = normalized.avatar;
    state.assistantAgentId = normalized.agentId ?? null;
  } catch {
    // Ignore errors; keep last known identity.
  }
}
