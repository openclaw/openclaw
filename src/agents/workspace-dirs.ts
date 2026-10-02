/**
 * Agent workspace directory collection.
 *
 * File sync and cleanup paths use this to enumerate configured agent workspaces
 * plus the default agent workspace without duplicating agent-scope logic.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../infra/home-dir.js";
import { listAgentEntries, listAgentIds, resolveAgentWorkspaceDir } from "./agent-scope-config.js";

/** Lists unique workspace directories for configured agents and the default agent. */
export function listAgentWorkspaceDirs(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const dirs = new Set<string>();
  for (const agentId of listAgentIds(cfg)) {
    dirs.add(resolveAgentWorkspaceDir(cfg, agentId, env));
  }
  return [...dirs];
}

/** Lists only entry-authored workspace paths without requiring a valid default marker. */
export function listExplicitAgentWorkspaceDirs(cfg: OpenClawConfig): string[] {
  const dirs = new Set<string>();
  for (const entry of listAgentEntries(cfg)) {
    const workspace = typeof entry.workspace === "string" ? entry.workspace.trim() : "";
    if (workspace) {
      dirs.add(resolveUserPath(workspace));
    }
  }
  return [...dirs];
}
