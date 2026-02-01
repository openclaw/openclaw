import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { resolveConfigDir, resolveUserPath } from "../utils.js";

export function resolveMediaLocalRoots(cfg: OpenClawConfig, agentId?: string): string[] {
  const roots = new Set<string>();
  roots.add(path.join(resolveConfigDir(), "media"));

  const addAgentRoots = (id: string) => {
    roots.add(resolveAgentWorkspaceDir(cfg, id));
    const sandboxRoot = resolveSandboxConfigForAgent(cfg, id).workspaceRoot;
    if (sandboxRoot) {
      roots.add(resolveUserPath(sandboxRoot));
    }
  };

  if (agentId) {
    addAgentRoots(agentId);
    return Array.from(roots);
  }

  for (const id of listAgentIds(cfg)) {
    addAgentRoots(id);
  }

  return Array.from(roots);
}
