import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveAgentIdentity } from "../agents/identity.js";
import { loadAgentIdentity } from "../commands/agents.config.js";
import type { ClawdbotConfig } from "../config/config.js";
import { normalizeAgentId } from "../routing/session-key.js";

const MAX_ASSISTANT_NAME = 50;
const MAX_ASSISTANT_AVATAR = 200;

export const DEFAULT_ASSISTANT_IDENTITY = {
  name: "Assistant",
  avatar: "A",
};

export type AssistantIdentity = {
  agentId: string;
  name: string;
  avatar: string;
};

function coerceIdentityValue(value: string | undefined, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(0, maxLength);
}

export function resolveAssistantIdentity(params: {
  cfg: ClawdbotConfig;
  agentId?: string | null;
  workspaceDir?: string | null;
}): AssistantIdentity {
  const agentId = normalizeAgentId(params.agentId ?? resolveDefaultAgentId(params.cfg));
  const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, agentId);
  const configAssistant = params.cfg.ui?.assistant;
  const agentIdentity = resolveAgentIdentity(params.cfg, agentId);
  const fileIdentity = workspaceDir ? loadAgentIdentity(workspaceDir) : null;

  const name =
    coerceIdentityValue(configAssistant?.name, MAX_ASSISTANT_NAME) ??
    coerceIdentityValue(agentIdentity?.name, MAX_ASSISTANT_NAME) ??
    coerceIdentityValue(fileIdentity?.name, MAX_ASSISTANT_NAME) ??
    DEFAULT_ASSISTANT_IDENTITY.name;

  const avatar =
    coerceIdentityValue(configAssistant?.avatar, MAX_ASSISTANT_AVATAR) ??
    coerceIdentityValue(agentIdentity?.avatar, MAX_ASSISTANT_AVATAR) ??
    coerceIdentityValue(agentIdentity?.emoji, MAX_ASSISTANT_AVATAR) ??
    coerceIdentityValue(fileIdentity?.avatar, MAX_ASSISTANT_AVATAR) ??
    coerceIdentityValue(fileIdentity?.emoji, MAX_ASSISTANT_AVATAR) ??
    DEFAULT_ASSISTANT_IDENTITY.avatar;

  return { agentId, name, avatar };
}
