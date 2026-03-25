import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveAgentIdentity } from "../agents/identity.js";
import { loadAgentIdentity } from "../commands/agents.config.js";
import type { OpenClawConfig } from "../config/config.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { coerceIdentityValue } from "../shared/assistant-identity-values.js";
import {
  isAvatarHttpUrl,
  isAvatarImageDataUrl,
  looksLikeAvatarPath,
} from "../shared/avatar-policy.js";

const MAX_ASSISTANT_NAME = 50;
const MAX_ASSISTANT_AVATAR = 200;
const MAX_ASSISTANT_EMOJI = 16;

export const DEFAULT_ASSISTANT_IDENTITY: AssistantIdentity = {
  agentId: "main",
  name: "Assistant",
  avatar: "A",
};

export type AssistantIdentity = {
  agentId: string;
  name: string;
  avatar: string;
  emoji?: string;
};

function isAvatarUrl(value: string): boolean {
  return isAvatarHttpUrl(value) || isAvatarImageDataUrl(value);
}

function normalizeAvatarValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (isAvatarUrl(trimmed)) {
    return trimmed;
  }
  if (looksLikeAvatarPath(trimmed)) {
    return trimmed;
  }
  if (!/\s/.test(trimmed) && trimmed.length <= 4) {
    return trimmed;
  }
  return undefined;
}

function normalizeEmojiValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > MAX_ASSISTANT_EMOJI) {
    return undefined;
  }
  let hasNonAscii = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed.charCodeAt(i) > 127) {
      hasNonAscii = true;
      break;
    }
  }
  if (!hasNonAscii) {
    return undefined;
  }
  if (isAvatarUrl(trimmed) || looksLikeAvatarPath(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function resolveAssistantIdentity(params: {
  cfg: OpenClawConfig;
  agentId?: string | null;
  workspaceDir?: string | null;
}): AssistantIdentity {
  const agentId = normalizeAgentId(params.agentId ?? resolveDefaultAgentId(params.cfg));
  const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, agentId);
  const configAssistant = params.cfg.ui?.assistant;
  const agentIdentity = resolveAgentIdentity(params.cfg, agentId);
  const fileIdentity = workspaceDir ? loadAgentIdentity(workspaceDir) : null;

  // For non-default agents (subagents), per-agent identity takes priority over
  // the global ui.assistant config. Global ui.assistant is the user's
  // customization of the default/main agent and should not override subagent
  // identities that were explicitly configured in agents.list[].identity.
  const isDefaultAgent = agentId === normalizeAgentId(resolveDefaultAgentId(params.cfg));
  const globalName = coerceIdentityValue(configAssistant?.name, MAX_ASSISTANT_NAME);
  const agentName = coerceIdentityValue(agentIdentity?.name, MAX_ASSISTANT_NAME);
  const fileName = coerceIdentityValue(fileIdentity?.name, MAX_ASSISTANT_NAME);

  const name = isDefaultAgent
    ? (globalName ?? agentName ?? fileName ?? DEFAULT_ASSISTANT_IDENTITY.name)
    : (agentName ?? fileName ?? globalName ?? DEFAULT_ASSISTANT_IDENTITY.name);

  const globalAvatar = coerceIdentityValue(configAssistant?.avatar, MAX_ASSISTANT_AVATAR);
  const agentAvatarCandidates = [
    coerceIdentityValue(agentIdentity?.avatar, MAX_ASSISTANT_AVATAR),
    coerceIdentityValue(agentIdentity?.emoji, MAX_ASSISTANT_AVATAR),
  ];
  const fileAvatarCandidates = [
    coerceIdentityValue(fileIdentity?.avatar, MAX_ASSISTANT_AVATAR),
    coerceIdentityValue(fileIdentity?.emoji, MAX_ASSISTANT_AVATAR),
  ];
  const avatarCandidates = isDefaultAgent
    ? [globalAvatar, ...agentAvatarCandidates, ...fileAvatarCandidates]
    : [...agentAvatarCandidates, ...fileAvatarCandidates, globalAvatar];
  const avatar =
    avatarCandidates.map((candidate) => normalizeAvatarValue(candidate)).find(Boolean) ??
    DEFAULT_ASSISTANT_IDENTITY.avatar;

  const emojiCandidates = [
    coerceIdentityValue(agentIdentity?.emoji, MAX_ASSISTANT_EMOJI),
    coerceIdentityValue(fileIdentity?.emoji, MAX_ASSISTANT_EMOJI),
    coerceIdentityValue(agentIdentity?.avatar, MAX_ASSISTANT_EMOJI),
    coerceIdentityValue(fileIdentity?.avatar, MAX_ASSISTANT_EMOJI),
  ];
  const emoji = emojiCandidates.map((candidate) => normalizeEmojiValue(candidate)).find(Boolean);

  return { agentId, name, avatar, emoji };
}
