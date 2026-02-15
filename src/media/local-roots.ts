import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { STATE_DIR } from "../config/paths.js";

const STATIC_LOCAL_ROOTS = [
  os.tmpdir(),
  path.join(STATE_DIR, "media"),
  path.join(STATE_DIR, "agents"),
  path.join(STATE_DIR, "workspace"),
  path.join(STATE_DIR, "sandboxes"),
] as const;

export function getDefaultMediaLocalRoots(): readonly string[] {
  return STATIC_LOCAL_ROOTS;
}

export function getAgentScopedMediaLocalRoots(
  cfg: OpenClawConfig,
  agentId?: string,
): readonly string[] {
  const roots = [...STATIC_LOCAL_ROOTS];
  if (!agentId?.trim()) {
    return roots;
  }
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  if (!workspaceDir) {
    return roots;
  }
  const normalizedWorkspaceDir = path.resolve(workspaceDir);
  if (!roots.includes(normalizedWorkspaceDir)) {
    roots.push(normalizedWorkspaceDir);
  }
  return roots;
}
