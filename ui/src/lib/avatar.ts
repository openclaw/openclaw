import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isRenderableAvatarImageDataUrl } from "../../../src/shared/avatar-limits.js";
import type { AgentIdentityResult } from "../api/types.ts";
import { DEFAULT_ASSISTANT_AVATAR } from "./assistant-identity.ts";

const CONTROL_UI_SAME_ORIGIN_AVATAR_URL_RE = /^\/(?!\/)/;
const UNSAFE_ASSISTANT_TEXT_AVATAR_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u;

export function isRenderableControlUiAvatarUrl(value: string): boolean {
  return isRenderableAvatarImageDataUrl(value) || CONTROL_UI_SAME_ORIGIN_AVATAR_URL_RE.test(value);
}

export function resolveAgentAvatarUrl(
  agent: { identity?: { avatar?: string; avatarUrl?: string } },
  agentIdentity?: AgentIdentityResult | null,
): string | null {
  // A resolved identity owns absence too; stale roster metadata cannot restore its image.
  const candidates = agentIdentity
    ? [agentIdentity.avatar]
    : [agent.identity?.avatarUrl, agent.identity?.avatar];
  return (
    candidates
      .map(normalizeOptionalString)
      .find((candidate) => candidate && isRenderableControlUiAvatarUrl(candidate)) ?? null
  );
}

// Chat-render variant: accept blob URLs produced by authenticated avatar fetches.
export function resolveChatAvatarRenderUrl(
  candidate: string | null | undefined,
  agent: { identity?: { avatar?: string; avatarUrl?: string } },
  agentIdentity?: AgentIdentityResult | null,
): string | null {
  const trimmed = normalizeOptionalString(candidate);
  if (trimmed?.startsWith("blob:")) {
    return trimmed;
  }
  return resolveAgentAvatarUrl(agent, agentIdentity);
}

export function resolveAssistantTextAvatar(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (
    !trimmed ||
    trimmed === DEFAULT_ASSISTANT_AVATAR ||
    trimmed.startsWith("blob:") ||
    isRenderableControlUiAvatarUrl(trimmed) ||
    trimmed.length > 8 ||
    /[\s\\/.:]/.test(trimmed) ||
    UNSAFE_ASSISTANT_TEXT_AVATAR_CHARS.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}
