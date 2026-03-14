import fs from "node:fs";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

type BuildMediaLocalRootsOptions = {
  preferredTmpDir?: string;
};

let cachedPreferredTmpDir: string | undefined;

function resolveCachedPreferredTmpDir(): string {
  if (!cachedPreferredTmpDir) {
    cachedPreferredTmpDir = resolvePreferredOpenClawTmpDir();
  }
  return cachedPreferredTmpDir;
}

function buildMediaLocalRoots(
  stateDir: string,
  options: BuildMediaLocalRootsOptions = {},
): string[] {
  const resolvedStateDir = path.resolve(stateDir);
  const preferredTmpDir = options.preferredTmpDir ?? resolveCachedPreferredTmpDir();
  return [
    preferredTmpDir,
    path.join(resolvedStateDir, "media"),
    path.join(resolvedStateDir, "agents"),
    path.join(resolvedStateDir, "workspace"),
    path.join(resolvedStateDir, "sandboxes"),
  ];
}

export function getDefaultMediaLocalRoots(): readonly string[] {
  return buildMediaLocalRoots(resolveStateDir());
}

export function getAgentScopedMediaLocalRoots(
  cfg: OpenClawConfig,
  agentId?: string,
): readonly string[] {
  const roots = buildMediaLocalRoots(resolveStateDir());
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
  // When the workspace is a symlink (e.g. virtiofs mount), also add the
  // realpath-resolved directory so assertLocalMediaAllowed matches files
  // whose paths were resolved through the symlink.
  try {
    const realWorkspaceDir = fs.realpathSync(normalizedWorkspaceDir);
    if (realWorkspaceDir !== normalizedWorkspaceDir && !roots.includes(realWorkspaceDir)) {
      roots.push(realWorkspaceDir);
    }
  } catch {
    // Workspace directory may not exist yet — ignore.
  }
  return roots;
}
