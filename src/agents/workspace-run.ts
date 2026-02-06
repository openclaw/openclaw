import { createHash } from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { resolveAgentWorkspaceDir } from "./agent-scope.js";

export type WorkspaceFallbackReason = "missing" | "blank" | "invalid_type";
type AgentIdSource = "explicit" | "session_key" | "default";

export type ResolveRunWorkspaceResult = {
  workspaceDir: string;
  usedFallback: boolean;
  fallbackReason?: WorkspaceFallbackReason;
  agentId: string;
  agentIdSource: AgentIdSource;
  malformedSessionKey: boolean;
};

function isKnownSessionAlias(raw: string): boolean {
  const normalized = raw.toLowerCase();
  return (
    normalized === "main" ||
    normalized === "global" ||
    normalized.startsWith("subagent:") ||
    normalized.startsWith("acp:")
  );
}

function resolveRunAgentId(params: { sessionKey?: string; agentId?: string }): {
  agentId: string;
  agentIdSource: AgentIdSource;
  malformedSessionKey: boolean;
} {
  const explicit =
    typeof params.agentId === "string" && params.agentId.trim()
      ? normalizeAgentId(params.agentId)
      : undefined;
  if (explicit) {
    return { agentId: explicit, agentIdSource: "explicit", malformedSessionKey: false };
  }

  const rawSessionKey = params.sessionKey?.trim() ?? "";
  if (!rawSessionKey) {
    return {
      agentId: DEFAULT_AGENT_ID,
      agentIdSource: "default",
      malformedSessionKey: false,
    };
  }

  const parsed = parseAgentSessionKey(rawSessionKey);
  if (parsed?.agentId) {
    return {
      agentId: normalizeAgentId(parsed.agentId),
      agentIdSource: "session_key",
      malformedSessionKey: false,
    };
  }

  return {
    agentId: DEFAULT_AGENT_ID,
    agentIdSource: "default",
    malformedSessionKey: !isKnownSessionAlias(rawSessionKey),
  };
}

export function redactRunIdentifier(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "-";
  }
  const hash = createHash("sha256").update(trimmed).digest("hex");
  return `sha256:${hash.slice(0, 12)}`;
}

export function resolveRunWorkspaceDir(params: {
  workspaceDir: unknown;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): ResolveRunWorkspaceResult {
  const requested = params.workspaceDir;
  const { agentId, agentIdSource, malformedSessionKey } = resolveRunAgentId(params);
  if (typeof requested === "string") {
    const trimmed = requested.trim();
    if (trimmed) {
      return {
        workspaceDir: resolveUserPath(trimmed),
        usedFallback: false,
        agentId,
        agentIdSource,
        malformedSessionKey,
      };
    }
  }

  const fallbackReason: WorkspaceFallbackReason =
    requested == null ? "missing" : typeof requested === "string" ? "blank" : "invalid_type";
  const fallbackWorkspace = resolveAgentWorkspaceDir(params.config ?? {}, agentId);
  return {
    workspaceDir: resolveUserPath(fallbackWorkspace),
    usedFallback: true,
    fallbackReason,
    agentId,
    agentIdSource,
    malformedSessionKey,
  };
}
