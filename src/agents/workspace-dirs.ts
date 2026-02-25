import type { ActiviConfig } from "../config/config.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "./agent-scope.js";

export function listAgentWorkspaceDirs(cfg: ActiviConfig): string[] {
  const dirs = new Set<string>();
  const list = cfg.agents?.list;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (entry && typeof entry === "object" && typeof entry.id === "string") {
        dirs.add(resolveAgentWorkspaceDir(cfg, entry.id));
      }
    }
  }
  dirs.add(resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)));
  return [...dirs];
}
