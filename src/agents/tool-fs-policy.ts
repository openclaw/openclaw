/**
 * Combines global and agent fs/tool policy into workspace-only and root-expansion decisions.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { pickSandboxToolPolicy } from "./sandbox-tool-policy.js";
import { resolveSessionPermissionCoreToolPolicy } from "./session-permission-exec-mode.js";
import type { PreparedSessionPermissionPolicy, ToolFsPolicy } from "./tool-fs-policy.types.js";
import { isToolAllowedByPolicies } from "./tool-policy-match.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "./tool-policy.js";

export type { PreparedSessionPermissionPolicy, ToolFsPolicy } from "./tool-fs-policy.types.js";
export { resolveSessionPermissionExecMode } from "./session-permission-exec-mode.js";

/** Capture the recorded boundary, or its resolved workspace when no root was pinned. */
export function resolveStoredSessionPermissionPolicy(
  entry:
    | { permissionMode?: PreparedSessionPermissionPolicy["mode"]; sessionRoot?: string }
    | undefined,
  resolvedWorkspace: string,
): PreparedSessionPermissionPolicy | undefined {
  return entry?.permissionMode
    ? Object.freeze({ mode: entry.permissionMode, root: entry.sessionRoot ?? resolvedWorkspace })
    : undefined;
}

export function resolveToolFsConfig(params: { cfg?: OpenClawConfig; agentId?: string }): {
  workspaceOnly?: boolean;
} {
  const cfg = params.cfg;
  const globalFs = cfg?.tools?.fs;
  const agentFs =
    cfg && params.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools?.fs : undefined;
  return {
    workspaceOnly: agentFs?.workspaceOnly ?? globalFs?.workspaceOnly,
  };
}

/**
 * Derive the filesystem policy for callers that build OpenClaw tools without one.
 * Mirrors the embedded runner: a session permission mode decides when present,
 * otherwise `tools.fs.workspaceOnly`. Returns undefined when unrestricted so
 * callers keep their unrestricted behavior; a restricted run can never be
 * mistaken for an unrestricted one by omission.
 */
export function resolveOpenClawToolsFsPolicy(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionPermissionPolicy?: PreparedSessionPermissionPolicy;
  /** Host-owned roots read-only tools may consume, such as a subagent attachment root. */
  attachmentReadRoot?: string;
}): ToolFsPolicy | undefined {
  const workspaceOnly = params.sessionPermissionPolicy
    ? resolveSessionPermissionCoreToolPolicy(params.sessionPermissionPolicy).workspaceOnly
    : resolveEffectiveToolFsWorkspaceOnly(params);
  if (!workspaceOnly) {
    return undefined;
  }
  return {
    workspaceOnly: true,
    ...(params.sessionPermissionPolicy ? { root: params.sessionPermissionPolicy.root } : {}),
    ...(params.attachmentReadRoot ? { readOnlyRoots: [params.attachmentReadRoot] } : {}),
  };
}

export function resolveEffectiveToolFsWorkspaceOnly(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): boolean {
  return resolveToolFsConfig(params).workspaceOnly === true;
}

export function resolveEffectiveToolFsRootExpansionAllowed(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  workspaceOnly?: boolean;
}): boolean {
  if ((params.workspaceOnly ?? resolveToolFsConfig(params).workspaceOnly) === true) {
    return false;
  }
  const cfg = params.cfg;
  if (!cfg) {
    return true;
  }
  const agentTools = params.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools : undefined;
  const globalTools = cfg.tools;
  const profile = agentTools?.profile ?? globalTools?.profile;
  const profileAlsoAllow = new Set(agentTools?.alsoAllow ?? globalTools?.alsoAllow ?? []);
  // tools.fs presence does not grant access; require profile or alsoAllow (#47487).
  const profilePolicy = mergeAlsoAllowPolicy(
    resolveToolProfilePolicy(profile),
    profileAlsoAllow.size > 0 ? Array.from(profileAlsoAllow) : undefined,
  );
  const globalPolicy = pickSandboxToolPolicy(globalTools);
  const agentPolicy = pickSandboxToolPolicy(agentTools);
  return isToolAllowedByPolicies("read", [profilePolicy, globalPolicy, agentPolicy]);
}
