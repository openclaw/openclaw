/**
 * Agent run workspace resolver.
 *
 * Selects per-run workspace directories and redacts run identifiers for logs/prompts.
 */
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import { classifySessionKeyShape, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { hasAgentRosterProperty } from "./agent-scope-config.js";
import {
  resolveAgentConfig,
  resolveSessionAgentId,
  resolveAgentWorkspaceDir,
} from "./agent-scope.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";

type WorkspaceFallbackReason = "missing" | "blank" | "invalid_type";
type AgentIdSource = "explicit" | "session_key" | "default";

export type ResolveRunWorkspaceResult = {
  workspaceDir: string;
  isCanonicalWorkspace: boolean;
  usedFallback: boolean;
  fallbackReason?: WorkspaceFallbackReason;
  agentId: string;
  agentIdSource: AgentIdSource;
};

const RUN_WORKSPACE_ROSTER_REQUIRED_ERROR_CODE = "RUN_WORKSPACE_ROSTER_REQUIRED";

class RunWorkspaceRosterRequiredError extends Error {
  readonly code = RUN_WORKSPACE_ROSTER_REQUIRED_ERROR_CODE;

  constructor() {
    super("No agents configured; run workspace resolution requires an explicit roster.");
    this.name = "RunWorkspaceRosterRequiredError";
  }
}

class RunWorkspaceAgentNotConfiguredError extends Error {
  readonly code = "RUN_WORKSPACE_AGENT_NOT_CONFIGURED";
  readonly agentId: string;

  constructor(agentId: string) {
    super(`Agent ${agentId} is not present in the configured roster.`);
    this.name = "RunWorkspaceAgentNotConfiguredError";
    this.agentId = agentId;
  }
}

/** Redacts a run/session identifier for logs and prompts. */
export function redactRunIdentifier(value: string | undefined): string {
  return redactIdentifier(value, { len: 12 });
}

/** Resolves the workspace directory used for an agent run. */
export function resolveRunWorkspaceDir(params: {
  workspaceDir: unknown;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): ResolveRunWorkspaceResult {
  const rawSessionKey = params.sessionKey?.trim() ?? "";
  if (classifySessionKeyShape(rawSessionKey) === "malformed_agent") {
    throw new Error("Malformed agent session key; refusing workspace resolution.");
  }
  // Workspace ownership is an isolation boundary. Raw/configless SDK inputs may
  // retain implicit-main routing compatibility, but must not invent an owner here.
  const config = params.config;
  if (!config || !hasAgentRosterProperty(config)) {
    throw new RunWorkspaceRosterRequiredError();
  }
  const env = params.env ?? process.env;
  const requested = params.workspaceDir;
  const agentId = resolveSessionAgentId({
    sessionKey: rawSessionKey || undefined,
    agentId: params.agentId,
    config,
  });
  const agentIdSource: AgentIdSource = params.agentId
    ? "explicit"
    : parseAgentSessionKey(rawSessionKey)?.agentId
      ? "session_key"
      : "default";
  if (!resolveAgentConfig(config, agentId)) {
    throw new RunWorkspaceAgentNotConfiguredError(agentId);
  }
  if (typeof requested === "string") {
    const trimmed = requested.trim();
    if (trimmed) {
      const sanitized = sanitizeForPromptLiteral(trimmed);
      if (sanitized !== trimmed) {
        logWarn("Control/format characters stripped from workspaceDir (OC-19 hardening).");
      }
      const workspaceDir = resolveUserPath(sanitized, env);
      const canonicalWorkspaceDir = resolveUserPath(
        resolveAgentWorkspaceDir(config, agentId, env),
        env,
      );
      return {
        workspaceDir,
        isCanonicalWorkspace: workspaceDir === canonicalWorkspaceDir,
        usedFallback: false,
        agentId,
        agentIdSource,
      };
    }
  }

  const fallbackReason: WorkspaceFallbackReason =
    requested == null ? "missing" : typeof requested === "string" ? "blank" : "invalid_type";
  const fallbackWorkspace = resolveAgentWorkspaceDir(config, agentId, env);
  const sanitizedFallback = sanitizeForPromptLiteral(fallbackWorkspace);
  if (sanitizedFallback !== fallbackWorkspace) {
    logWarn("Control/format characters stripped from fallback workspaceDir (OC-19 hardening).");
  }
  return {
    workspaceDir: resolveUserPath(sanitizedFallback, env),
    isCanonicalWorkspace: true,
    usedFallback: true,
    fallbackReason,
    agentId,
    agentIdSource,
  };
}
