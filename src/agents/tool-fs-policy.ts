/**
 * Tool filesystem policy resolver.
 *
 * Combines global and agent fs/tool policy into workspace-only and root-expansion decisions.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { FsRoot } from "../config/types.tools.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { pickSandboxToolPolicy } from "./sandbox-tool-policy.js";
import type { ToolFsPolicy } from "./tool-fs-policy.types.js";
import { isToolAllowedByPolicies } from "./tool-policy-match.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "./tool-policy.js";

export type { ToolFsPolicy } from "./tool-fs-policy.types.js";

export function createToolFsPolicy(params: {
  workspaceOnly?: boolean;
  roots?: FsRoot[];
}): ToolFsPolicy {
  if (params.roots && params.workspaceOnly) {
    console.warn(
      "[tools.fs] Both workspaceOnly and roots are set. roots takes precedence — remove workspaceOnly to avoid ambiguity.",
    );
  }
  return {
    // Preserve workspaceOnly even when roots is set — in sandbox mode, roots are
    // ignored and workspaceOnly must still be honored as the fallback guard.
    // In host mode, the read tool uses roots (not workspaceOnly) when both exist.
    workspaceOnly: params.workspaceOnly === true,
    roots: params.roots,
  };
}

export function resolveToolFsConfig(params: { cfg?: OpenClawConfig; agentId?: string }): {
  workspaceOnly?: boolean;
  roots?: FsRoot[];
} {
  const cfg = params.cfg;
  const globalFs = cfg?.tools?.fs;
  const agentFs =
    cfg && params.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools?.fs : undefined;
  const workspaceOnly = agentFs?.workspaceOnly ?? globalFs?.workspaceOnly;

  // Agent-level roots take full precedence
  const roots = agentFs?.roots ?? globalFs?.roots;
  // Empty roots array is a valid deny-all policy — don't fall through to unrestricted
  if (roots) {
    return { roots, workspaceOnly };
  }

  return {
    workspaceOnly,
  };
}

export function resolveEffectiveToolFsWorkspaceOnly(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): boolean {
  const config = resolveToolFsConfig(params);
  // Preserve workspaceOnly even when roots is set — in sandbox mode, roots are
  // ignored and workspaceOnly must still be honored (e.g., prompt-image auto-load).
  // In host mode, the read tool uses roots instead of workspaceOnly when both exist.
  return config.workspaceOnly === true;
}

export function resolveEffectiveToolFsRootExpansionAllowed(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): boolean {
  const cfg = params.cfg;
  if (!cfg) {
    return true;
  }
  const agentTools = params.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools : undefined;
  const globalTools = cfg.tools;
  const profile = agentTools?.profile ?? globalTools?.profile;
  const profileAlsoAllow = new Set(agentTools?.alsoAllow ?? globalTools?.alsoAllow ?? []);
  const fsConfig = resolveToolFsConfig(params);
  // An explicit roots allowlist is a deliberate opt-in to host-path access — the
  // explicit grant #47487 asks for — so it enables root expansion even under a
  // restrictive profile. (A bare `tools.fs` block, by contrast, must not grant.)
  if (fsConfig.roots !== undefined) {
    return true;
  }
  if (fsConfig.workspaceOnly === true) {
    return false;
  }
  // tools.fs presence does not grant access; require profile or alsoAllow (#47487).
  const profilePolicy = mergeAlsoAllowPolicy(
    resolveToolProfilePolicy(profile),
    profileAlsoAllow.size > 0 ? Array.from(profileAlsoAllow) : undefined,
  );
  const globalPolicy = pickSandboxToolPolicy(globalTools);
  const agentPolicy = pickSandboxToolPolicy(agentTools);
  return isToolAllowedByPolicies("read", [profilePolicy, globalPolicy, agentPolicy]);
}
