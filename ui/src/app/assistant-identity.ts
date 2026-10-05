import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { fetchAgentIdentity } from "../lib/agents/identity.ts";
import { normalizeAssistantIdentity, type AssistantIdentity } from "../lib/assistant-identity.ts";
import { getSafeLocalStorage } from "../local-storage.ts";

const LOCAL_ASSISTANT_IDENTITY_KEY = "openclaw.control.assistant.v1";

type LocalAssistantIdentity = { avatar: string | null };

type PersistedLocalAssistantIdentities = {
  avatars?: Record<string, unknown>;
};

function parseLocalAssistantAvatarMap(raw: string): Record<string, string> {
  const parsed = JSON.parse(raw) as PersistedLocalAssistantIdentities;
  const avatars = Object.create(null) as Record<string, string>;
  if (parsed.avatars && typeof parsed.avatars === "object" && !Array.isArray(parsed.avatars)) {
    for (const [agentId, avatar] of Object.entries(parsed.avatars)) {
      const normalizedAgentId = normalizeOptionalString(agentId);
      const normalizedAvatar = normalizeOptionalString(avatar);
      if (normalizedAgentId && normalizedAvatar) {
        avatars[normalizedAgentId] = normalizedAvatar;
      }
    }
  }
  return avatars;
}

export function loadLocalAssistantIdentity(opts?: {
  agentId?: string | null;
}): LocalAssistantIdentity {
  const agentId = normalizeOptionalString(opts?.agentId);
  if (!agentId) {
    return { avatar: null };
  }
  const storage = getSafeLocalStorage();
  try {
    const raw = storage?.getItem(LOCAL_ASSISTANT_IDENTITY_KEY);
    if (!raw) {
      return { avatar: null };
    }
    const avatars = parseLocalAssistantAvatarMap(raw);
    return { avatar: Object.hasOwn(avatars, agentId) ? (avatars[agentId] ?? null) : null };
  } catch {
    return { avatar: null };
  }
}

export async function fetchAssistantIdentity(
  client: GatewayBrowserClient,
  agentId: string,
): Promise<AssistantIdentity | null> {
  const result = await fetchAgentIdentity(client, agentId);
  if (!result) {
    return null;
  }
  const identity = normalizeAssistantIdentity(result);
  const localAvatar = loadLocalAssistantIdentity({ agentId: identity.agentId }).avatar;
  return localAvatar
    ? {
        ...identity,
        avatar: localAvatar,
        avatarSource: localAvatar,
        avatarStatus: "data",
        avatarReason: null,
      }
    : identity;
}
