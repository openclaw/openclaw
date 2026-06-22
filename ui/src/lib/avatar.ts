import type { AgentIdentityResult } from "../api/types.ts";
import { normalizeOptionalString } from "./string-coerce.ts";

const CONTROL_UI_AVATAR_URL_RE = /^(data:image\/|\/(?!\/))/i;

export function isRenderableControlUiAvatarUrl(value: string): boolean {
  return CONTROL_UI_AVATAR_URL_RE.test(value);
}

export function resolveAgentAvatarUrl(
  agent: { identity?: { avatar?: string; avatarUrl?: string } },
  agentIdentity?: AgentIdentityResult | null,
): string | null {
  const candidates = [
    normalizeOptionalString(agentIdentity?.avatar),
    normalizeOptionalString(agent.identity?.avatarUrl),
    normalizeOptionalString(agent.identity?.avatar),
  ];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (isRenderableControlUiAvatarUrl(candidate)) {
      return candidate;
    }
  }
  return null;
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
