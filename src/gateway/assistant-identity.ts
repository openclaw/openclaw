// Gateway assistant identity resolver.
// Combines UI, agent config, and workspace identity files for Control UI display.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveAgentIdentity } from "../agents/identity.js";
import { loadAgentIdentity } from "../commands/agents.config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  AVATAR_MAX_DATA_URL_CHARS,
  isRenderableAvatarImageDataUrl,
} from "../shared/avatar-limits.js";
import {
  hasAvatarUriScheme,
  isAvatarHttpUrl,
  isWindowsAbsolutePath,
  looksLikeAvatarPath,
} from "../shared/avatar-policy.js";

const ASSISTANT_IDENTITY_LIMITS = {
  name: 50,
  emoji: 16,
} as const;
type AssistantIdentityField = keyof typeof ASSISTANT_IDENTITY_LIMITS;

export const DEFAULT_ASSISTANT_IDENTITY: AssistantIdentity = {
  agentId: "main",
  name: "Assistant",
  avatar: "A",
};

type AssistantIdentity = {
  agentId: string;
  name: string;
  avatar: string;
  emoji?: string;
};

function normalizeIdentityValue(
  field: AssistantIdentityField,
  value: string | undefined,
): string | undefined {
  const trimmed = normalizeOptionalString(value);
  return trimmed ? truncateUtf16Safe(trimmed, ASSISTANT_IDENTITY_LIMITS[field]) : undefined;
}

function isAvatarUrl(value: string): boolean {
  return isAvatarHttpUrl(value) || isRenderableAvatarImageDataUrl(value);
}

function normalizeAvatarValue(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed || trimmed.length > AVATAR_MAX_DATA_URL_CHARS) {
    return undefined;
  }
  if (isAvatarUrl(trimmed)) {
    return trimmed;
  }
  // URI-like values are not local paths. Reject unsupported schemes before
  // the slash heuristic so a bad high-priority value cannot shadow a fallback.
  if (hasAvatarUriScheme(trimmed) && !isWindowsAbsolutePath(trimmed)) {
    return undefined;
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
  let hasNonAscii = false;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 127) {
      hasNonAscii = true;
      break;
    }
  }
  if (!hasNonAscii) {
    return undefined;
  }
  if (
    isAvatarUrl(value) ||
    (hasAvatarUriScheme(value) && !isWindowsAbsolutePath(value)) ||
    looksLikeAvatarPath(value)
  ) {
    return undefined;
  }
  return value;
}

/**
 * Assistant display name from ui.assistant, agent config identity, and the
 * workspace IDENTITY.md; undefined when none of them name the agent. Shared
 * by agent.identity.get and agents.list so sidebar agent labels cannot drift
 * from the chat-header identity (#108373).
 */
export function resolveAssistantDisplayName(params: {
  cfg: OpenClawConfig;
  agentId?: string | null;
  workspaceDir?: string | null;
}): string | undefined {
  const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(params.cfg));
  const agentId = normalizeAgentId(params.agentId ?? defaultAgentId);
  const isDefaultAgent = agentId === defaultAgentId;
  const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, agentId);
  const uiName = normalizeIdentityValue("name", params.cfg.ui?.assistant?.name);
  const agentName = normalizeIdentityValue("name", resolveAgentIdentity(params.cfg, agentId)?.name);
  const fileName = normalizeIdentityValue(
    "name",
    workspaceDir ? loadAgentIdentity(workspaceDir)?.name : undefined,
  );
  return isDefaultAgent ? (uiName ?? agentName ?? fileName) : (agentName ?? fileName ?? uiName);
}

/** Resolve the display name/avatar/emoji for an agent-facing assistant identity. */
export function resolveAssistantIdentity(params: {
  cfg: OpenClawConfig;
  agentId?: string | null;
  workspaceDir?: string | null;
}): AssistantIdentity {
  const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(params.cfg));
  const agentId = normalizeAgentId(params.agentId ?? defaultAgentId);
  const isDefaultAgent = agentId === defaultAgentId;
  const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, agentId);
  const configAssistant = params.cfg.ui?.assistant;
  const agentIdentity = resolveAgentIdentity(params.cfg, agentId);
  const fileIdentity = workspaceDir ? loadAgentIdentity(workspaceDir) : null;

  // One canonical name chain; the extra IDENTITY.md read inside the helper is
  // acceptable for this operator RPC and keeps agents.list from drifting.
  const name =
    resolveAssistantDisplayName({ cfg: params.cfg, agentId, workspaceDir }) ??
    DEFAULT_ASSISTANT_IDENTITY.name;

  const uiAvatar = normalizeAvatarValue(configAssistant?.avatar);
  const agentAvatarCandidates = [
    normalizeAvatarValue(agentIdentity?.avatar),
    normalizeAvatarValue(agentIdentity?.emoji),
    normalizeAvatarValue(fileIdentity?.avatar),
    normalizeAvatarValue(fileIdentity?.emoji),
  ];
  const avatarCandidates = isDefaultAgent
    ? [uiAvatar, ...agentAvatarCandidates]
    : [...agentAvatarCandidates, uiAvatar];
  const avatar = avatarCandidates.find(Boolean) ?? DEFAULT_ASSISTANT_IDENTITY.avatar;

  const emojiCandidates = [
    normalizeIdentityValue("emoji", agentIdentity?.emoji),
    normalizeIdentityValue("emoji", fileIdentity?.emoji),
    normalizeIdentityValue("emoji", agentIdentity?.avatar),
    normalizeIdentityValue("emoji", fileIdentity?.avatar),
  ];
  const emoji = emojiCandidates.map((candidate) => normalizeEmojiValue(candidate)).find(Boolean);

  return { agentId, name, avatar, emoji };
}
