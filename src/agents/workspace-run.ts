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
  const trimmed = typeof requested === "string" ? requested.trim() : "";
  const usedFallback = !trimmed;
  const candidate = trimmed || resolveAgentWorkspaceDir(config, agentId, env);
  const sanitized = sanitizeForPromptLiteral(candidate);
  if (sanitized !== candidate) {
    logWarn(
      usedFallback
        ? "Control/format characters stripped from fallback workspaceDir (OC-19 hardening)."
        : "Control/format characters stripped from workspaceDir (OC-19 hardening).",
    );
  }
  const workspaceDir = resolveUserPath(sanitized, env);
  const fallbackReason: WorkspaceFallbackReason =
    requested == null ? "missing" : typeof requested === "string" ? "blank" : "invalid_type";
  return {
    workspaceDir,
    isCanonicalWorkspace:
      usedFallback ||
      workspaceDir === resolveUserPath(resolveAgentWorkspaceDir(config, agentId, env), env),
    usedFallback,
    ...(usedFallback ? { fallbackReason } : {}),
    agentId,
    agentIdSource,
  };
}

/** Rooted execution borrows plugin facts only from its agent's canonical bootstrap workspace. */
export function resolveRootedRunRuntimeWorkspace(params: {
  workspaceDir: string;
  bootstrapWorkspaceDir?: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  requireWorkspaceOnly?: boolean;
  sessionRoot?: string;
}): ResolveRunWorkspaceResult | undefined {
  if (
    !params.bootstrapWorkspaceDir?.trim() ||
    !params.config ||
    !hasAgentRosterProperty(params.config)
  ) {
    return undefined;
  }
  const bootstrap = resolveRunWorkspaceDir({
    ...params,
    workspaceDir: params.bootstrapWorkspaceDir,
  });
  if (!bootstrap.isCanonicalWorkspace || bootstrap.usedFallback) {
    return undefined;
  }
  // Cron also supplies bootstrapWorkspaceDir without an execution root. Those runs still rebind
  // their workspace on reload; an explicit confinement root remains pinned even at the same path.
  return params.workspaceDir !== bootstrap.workspaceDir ||
    (params.requireWorkspaceOnly === true && params.sessionRoot !== undefined)
    ? bootstrap
    : undefined;
}

/** Resolves the agent's canonical workspace for a run that executes somewhere else. */
export function resolveCanonicalRunRuntimeWorkspace(params: {
  workspaceDir: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): ResolveRunWorkspaceResult | undefined {
  if (!params.config || !hasAgentRosterProperty(params.config)) {
    return undefined;
  }
  const { fallbackReason: _fallbackReason, ...canonical } = resolveRunWorkspaceDir({
    ...params,
    workspaceDir: undefined,
  });
  return canonical.workspaceDir === resolveUserPath(params.workspaceDir, params.env ?? process.env)
    ? undefined
    : { ...canonical, usedFallback: false };
}
