import {
  fetchAssistantIdentity,
  saveLocalAssistantIdentity,
} from "../../app/assistant-identity.ts";
// Control UI controller manages assistant identity gateway state.
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
  assistantAvatar?: string | null;
  assistantAvatarSource?: string | null;
  assistantAvatarStatus?: "none" | "local" | "remote" | "data" | null;
  assistantAvatarReason?: string | null;
};

const assistantIdentityRequestVersions = new WeakMap<object, number>();

function beginAssistantIdentityRequest(state: AssistantIdentityState): number {
  const key = state as object;
  const nextVersion = (assistantIdentityRequestVersions.get(key) ?? 0) + 1;
  assistantIdentityRequestVersions.set(key, nextVersion);
  return nextVersion;
}

function shouldApplyAssistantIdentityResult(
  state: AssistantIdentityState,
  version: number,
  sessionKey: string,
): boolean {
  return (
    assistantIdentityRequestVersions.get(state as object) === version &&
    state.sessionKey.trim() === sessionKey
  );
}

export async function loadAssistantIdentity(
  state: AssistantIdentityState,
  opts?: { sessionKey?: string; expectedSessionKey?: string },
) {
  if (!state.client || !state.connected) {
    return;
  }
  const sessionKey = opts?.sessionKey?.trim() || state.sessionKey.trim();
  const expectedSessionKey = opts?.expectedSessionKey?.trim() || sessionKey;
  const requestVersion = beginAssistantIdentityRequest(state);
  try {
    const normalized = await fetchAssistantIdentity(state.client, sessionKey);
    if (!shouldApplyAssistantIdentityResult(state, requestVersion, expectedSessionKey)) {
      return;
    }
    if (!normalized) {
      return;
    }
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

export function setAssistantAvatarOverride(
  state: AssistantAvatarOverrideState,
  avatar: string | null,
  agentId?: string | null,
) {
  saveLocalAssistantIdentity({ avatar, agentId });
  if (avatar) {
    state.assistantAvatar = avatar;
    state.assistantAvatarSource = avatar;
    state.assistantAvatarStatus = "data";
    state.assistantAvatarReason = null;
  } else {
    state.assistantAvatar = null;
    state.assistantAvatarSource = null;
    state.assistantAvatarStatus = null;
    state.assistantAvatarReason = null;
  }
}
