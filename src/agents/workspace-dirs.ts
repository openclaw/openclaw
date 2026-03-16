import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAgentMultipleWorkspaces,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "./agent-scope.js";

export function listAgentWorkspaceDirs(cfg: OpenClawConfig): string[] {
  const dirs = new Set<string>();
  const list = cfg.agents?.list;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (entry && typeof entry === "object" && typeof entry.id === "string") {
        dirs.add(resolveAgentWorkspaceDir(cfg, entry.id));
        // Also include individual multipleWorkspaces entries.
        const multiWs = resolveAgentMultipleWorkspaces(cfg, entry.id);
        if (multiWs) {
          for (const ws of multiWs) {
            dirs.add(ws);
          }
        }
      }
    }
  }
  dirs.add(resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)));
  return [...dirs];
}
