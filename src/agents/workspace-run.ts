/**
 * Agent run workspace resolver.
 *
 * Selects per-run workspace directories and redacts run identifiers for logs/prompts.
 */
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import { classifySessionKeyShape } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { hasAgentRosterProperty } from "./agent-scope-config.js";
import {
  resolveAgentConfig,
  resolveSessionAgentId,
  resolveAgentWorkspaceDir,
} from "./agent-scope.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "./tool-fs-policy.js";

type WorkspaceFallbackReason = "missing" | "blank" | "invalid_type";

export type ResolveRunWorkspaceResult = {
  workspaceDir: string;
  isCanonicalWorkspace: boolean;
  usedFallback: boolean;
  fallbackReason?: WorkspaceFallbackReason;
  agentId: string;
};

/** Redacts a run/session identifier for logs and prompts. */
export function redactRunIdentifier(value: string | undefined): string {
  return redactIdentifier(value, { len: 12 });
}

/** Recorded session roots own bootstrap files; cwd alone never selects instructions. */
export function resolveRunBootstrapWorkspaceDir(
  params: Parameters<typeof resolveRootedRunRuntimeWorkspace>[0],
  fallback = params.bootstrapWorkspaceDir ?? params.workspaceDir,
): string {
  const confined =
    params.requireWorkspaceOnly ||
    resolveEffectiveToolFsWorkspaceOnly({ cfg: params.config, agentId: params.agentId });
  return resolveUserPath(params.sessionRoot ?? (confined ? params.workspaceDir : fallback));
}

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
    throw Object.assign(
      new Error("No agents configured; run workspace resolution requires an explicit roster."),
      { name: "RunWorkspaceRosterRequiredError", code: "RUN_WORKSPACE_ROSTER_REQUIRED" },
    );
  }
  const env = params.env ?? process.env;
  const requested = params.workspaceDir;
  const agentId = resolveSessionAgentId({
    sessionKey: rawSessionKey || undefined,
    agentId: params.agentId,
    config,
  });
  if (!resolveAgentConfig(config, agentId)) {
    throw Object.assign(new Error(`Agent ${agentId} is not present in the configured roster.`), {
      name: "RunWorkspaceAgentNotConfiguredError",
      code: "RUN_WORKSPACE_AGENT_NOT_CONFIGURED",
      agentId,
    });
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
  };
}

/** Rooted execution borrows plugin facts only from its agent's canonical bootstrap workspace. */
export function resolveRootedRunRuntimeWorkspace(
  params: Parameters<typeof resolveRunWorkspaceDir>[0] & {
    workspaceDir: string;
    bootstrapWorkspaceDir?: string;
    requireWorkspaceOnly?: boolean;
    sessionRoot?: string;
  },
): ResolveRunWorkspaceResult | undefined {
  if (!params.bootstrapWorkspaceDir?.trim() || !hasAgentRosterProperty(params.config)) {
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
export function resolveCanonicalRunRuntimeWorkspace(
  params: Parameters<typeof resolveRunWorkspaceDir>[0] & { workspaceDir: string },
): ResolveRunWorkspaceResult | undefined {
  if (!hasAgentRosterProperty(params.config)) {
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
