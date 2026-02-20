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
  if (agentId?.trim()) {
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    if (workspaceDir) {
      const normalizedWorkspaceDir = path.resolve(workspaceDir);
      if (!roots.includes(normalizedWorkspaceDir)) {
        roots.push(normalizedWorkspaceDir);
      }
    }
  }
  // Merge user-configured extra media roots from messages.mediaLocalRoots
  const extra = cfg.messages?.mediaLocalRoots;
  if (extra) {
    for (const dir of extra) {
      const trimmed = dir.trim();
      if (!trimmed || !path.isAbsolute(trimmed)) continue;
      const resolved = path.resolve(trimmed);
      if (!roots.includes(resolved)) {
        roots.push(resolved);
      }
    }
  }
  return roots;
}
