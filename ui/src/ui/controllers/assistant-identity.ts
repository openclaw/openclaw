import { normalizeAssistantIdentity } from "../assistant-identity.ts";
import type { GatewayBrowserClient } from "../gateway.ts";

export type AssistantIdentityState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAvatarSource?: string | null;
  assistantAvatarStatus?: "none" | "local" | "remote" | "data" | null;
  assistantAvatarReason?: string | null;
  assistantAgentId: string | null;
};

export type AssistantAvatarOverrideState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  applySessionKey?: string;
  configSnapshot?: { hash?: string | null } | null;
};

export async function loadAssistantIdentity(
  state: AssistantIdentityState,
  opts?: { sessionKey?: string },
) {
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
    const normalized = normalizeAssistantIdentity(res);
    state.assistantName = normalized.name;
    state.assistantAvatar = normalized.avatar;
    state.assistantAvatarSource = normalized.avatarSource ?? null;
    state.assistantAvatarStatus = normalized.avatarStatus ?? null;
    state.assistantAvatarReason = normalized.avatarReason ?? null;
    state.assistantAgentId = normalized.agentId ?? null;
  } catch {
    // Ignore errors; keep last known identity.
  }
}

export async function setAssistantAvatarOverride(
  state: AssistantAvatarOverrideState,
  avatar: string | null,
) {
  if (!state.client || !state.connected) {
    throw new Error("Gateway is not connected.");
  }
  const baseHash = state.configSnapshot?.hash;
  if (!baseHash) {
    throw new Error("Config hash missing; refresh and retry.");
  }
  await state.client.request("config.patch", {
    baseHash,
    raw: JSON.stringify({ ui: { assistant: { avatar } } }),
    sessionKey: state.applySessionKey,
    note: avatar
      ? "Assistant avatar override updated from Control UI."
      : "Assistant avatar override cleared from Control UI.",
  });
}
