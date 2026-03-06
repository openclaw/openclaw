import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { resolveUserPath } from "../utils.js";

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

export function resolveTelegramMediaLocalRoots(
  cfg: OpenClawConfig,
  accountId?: string,
): readonly string[] | undefined {
  const telegram = cfg.channels?.telegram;
  if (!telegram) {
    return undefined;
  }
  const accountRoots = accountId ? telegram.accounts?.[accountId]?.mediaLocalRoots : undefined;
  const roots = accountRoots ?? telegram.mediaLocalRoots;
  if (!roots || roots.length === 0) {
    return undefined;
  }
  return roots;
}

export function getAgentScopedMediaLocalRoots(
  cfg: OpenClawConfig,
  agentId?: string,
  extraRoots?: readonly string[],
): readonly string[] {
  const roots = buildMediaLocalRoots(resolveStateDir());
  if (extraRoots) {
    for (const root of extraRoots) {
      const normalizedRoot = path.resolve(resolveUserPath(root));
      if (!roots.includes(normalizedRoot)) {
        roots.push(normalizedRoot);
      }
    }
  }
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
