// Gateway assistant identity resolver.
// Combines agent config and workspace identity files for Control UI display.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { listAgentEntries } from "../agents/agent-scope-config.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import {
  loadAgentIdentityFromWorkspaceAsync,
  type AgentIdentityFile,
} from "../agents/identity-file.js";
import { resolveAgentIdentity } from "../agents/identity.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
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

type AssistantIdentity = {
  name: string;
  avatar: string;
  emoji?: string;
};

type AssistantIdentityNameSource = "agent" | "workspace" | "default";
type ResolvedAssistantIdentity = AssistantIdentity & {
  agentId: string;
  nameSource: AssistantIdentityNameSource;
};

const preparedIdentities = new WeakMap<
  OpenClawConfig,
  Map<
    string,
    {
      file: AgentIdentityFile | null;
      name?: string;
      emoji?: string;
      avatar?: string;
      identity: ResolvedAssistantIdentity;
    }
  >
>();

export const DEFAULT_ASSISTANT_IDENTITY: AssistantIdentity = {
  name: "Assistant",
  avatar: "A",
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
  if (!value || !/\P{ASCII}/u.test(value)) {
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

// Presentation may choose the first roster entry even when ambient work needs an explicit owner.
export function resolveAssistantAgentId(cfg: OpenClawConfig, agentId?: string | null): string {
  return normalizeAgentId(
    agentId ?? tryResolveLegacyCompatibilityAgentId(cfg) ?? listAgentEntries(cfg)[0]?.id ?? "main",
  );
}

/** Resolve the display name/avatar/emoji for an agent-facing assistant identity. */
export async function resolveAssistantIdentity(params: {
  cfg: OpenClawConfig;
  agentId?: string | null;
  workspaceDir?: string | null;
}): Promise<ResolvedAssistantIdentity> {
  const agentId = resolveAssistantAgentId(params.cfg, params.agentId);
  const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, agentId);
  const {
    name: configuredName,
    emoji: configuredEmoji,
    avatar: configuredAvatar,
  } = resolveAgentIdentity(params.cfg, agentId) ?? {};
  const fileIdentity = workspaceDir
    ? await loadAgentIdentityFromWorkspaceAsync(workspaceDir)
    : null;
  let prepared = preparedIdentities.get(params.cfg);
  if (!prepared) {
    prepared = new Map();
    preparedIdentities.set(params.cfg, prepared);
  }
  const key = JSON.stringify([agentId, workspaceDir]);
  const cached = prepared.get(key);
  if (
    cached &&
    cached.file === fileIdentity &&
    cached.name === configuredName &&
    cached.emoji === configuredEmoji &&
    cached.avatar === configuredAvatar
  ) {
    prepared.delete(key);
    prepared.set(key, cached);
    return cached.identity;
  }

  const agentName = normalizeIdentityValue("name", configuredName);
  const fileName = normalizeIdentityValue("name", fileIdentity?.name);
  const resolvedName: [string, AssistantIdentityNameSource] | undefined = agentName
    ? [agentName, "agent"]
    : fileName
      ? [fileName, "workspace"]
      : undefined;
  const [name, nameSource] = resolvedName ?? [DEFAULT_ASSISTANT_IDENTITY.name, "default"];

  const avatarCandidates = [
    normalizeAvatarValue(configuredAvatar),
    normalizeAvatarValue(configuredEmoji),
    normalizeAvatarValue(fileIdentity?.avatar),
    normalizeAvatarValue(fileIdentity?.emoji),
  ];
  const avatar = avatarCandidates.find(Boolean) ?? DEFAULT_ASSISTANT_IDENTITY.avatar;

  const emojiCandidates = [
    normalizeIdentityValue("emoji", configuredEmoji),
    normalizeIdentityValue("emoji", fileIdentity?.emoji),
    normalizeIdentityValue("emoji", configuredAvatar),
    normalizeIdentityValue("emoji", fileIdentity?.avatar),
  ];
  const emoji = emojiCandidates.map((candidate) => normalizeEmojiValue(candidate)).find(Boolean);

  const identity = { agentId, name, nameSource, avatar, emoji };
  prepared.set(key, {
    file: fileIdentity,
    name: configuredName,
    emoji: configuredEmoji,
    avatar: configuredAvatar,
    identity,
  });
  pruneMapToMaxSize(prepared, 4);
  return identity;
}
