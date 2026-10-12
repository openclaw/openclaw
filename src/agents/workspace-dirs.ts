import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../infra/home-dir.js";
import { listAgentEntries, listAgentIds, resolveAgentWorkspaceDir } from "./agent-scope-config.js";

export function listAgentWorkspaceDirs(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [
    ...new Set(listAgentIds(cfg).map((agentId) => resolveAgentWorkspaceDir(cfg, agentId, env))),
  ];
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
