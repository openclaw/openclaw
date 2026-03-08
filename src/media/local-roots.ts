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
  channel?: string,
  accountId?: string | null,
): readonly string[] | "any" {
  // Check for channel-specific mediaLocalRoots configuration first
  if (channel) {
    const channelCfg = cfg.channels?.[channel as keyof typeof cfg.channels];
    if (channelCfg && typeof channelCfg === "object") {
      const channelObj = channelCfg as Record<string, unknown>;
      
      // Check for account-specific mediaLocalRoots first (for multi-account channels)
      if (accountId && channelObj.accounts && typeof channelObj.accounts === "object") {
        const accounts = channelObj.accounts as Record<string, unknown>;
        const accountCfg = accounts[accountId] as Record<string, unknown> | undefined;
        if (accountCfg?.mediaLocalRoots !== undefined) {
          if (accountCfg.mediaLocalRoots === "any") {
            return "any";
          }
          if (Array.isArray(accountCfg.mediaLocalRoots) && accountCfg.mediaLocalRoots.length > 0) {
            return accountCfg.mediaLocalRoots as readonly string[];
          }
        }
      }
      
      // Fall back to channel-level mediaLocalRoots
      if (channelObj.mediaLocalRoots !== undefined) {
        if (channelObj.mediaLocalRoots === "any") {
          return "any";
        }
        if (Array.isArray(channelObj.mediaLocalRoots) && channelObj.mediaLocalRoots.length > 0) {
          return channelObj.mediaLocalRoots as readonly string[];
        }
      }
    }
  }
  
  // Use default roots if no channel-specific config
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
  return roots;
}
