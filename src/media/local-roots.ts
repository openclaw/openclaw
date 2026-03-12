import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { ChannelId } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { expandHomePrefix } from "../infra/home-dir.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

type BuildMediaLocalRootsOptions = {
  preferredTmpDir?: string;
};

type ResolveMediaLocalRootsOptions = {
  channel?: ChannelId;
  accountId?: string | null;
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

function appendConfiguredMediaLocalRoots(
  roots: string[],
  cfg: OpenClawConfig,
  options: ResolveMediaLocalRootsOptions,
) {
  const channel = options.channel?.trim();
  if (!channel) {
    return;
  }

  const channelCfg = cfg.channels?.[channel];
  const channelObj =
    channelCfg && typeof channelCfg === "object"
      ? (channelCfg as Record<string, unknown>)
      : undefined;
  const accountId = typeof options.accountId === "string" ? options.accountId.trim() : "";
  const accountsObj =
    channelObj?.accounts && typeof channelObj.accounts === "object"
      ? (channelObj.accounts as Record<string, unknown>)
      : undefined;
  const accountCfg = accountId && accountsObj ? accountsObj[accountId] : undefined;

  const configuredRoots = [
    ...(Array.isArray(channelObj?.mediaLocalRoots) ? channelObj.mediaLocalRoots : []),
    ...(accountCfg &&
    typeof accountCfg === "object" &&
    Array.isArray((accountCfg as Record<string, unknown>).mediaLocalRoots)
      ? ((accountCfg as Record<string, unknown>).mediaLocalRoots as unknown[])
      : []),
  ];

  for (const root of configuredRoots) {
    if (typeof root !== "string" || !root.trim()) {
      continue;
    }
    const trimmedRoot = root.trim();
    const expandedRoot = trimmedRoot.startsWith("~") ? expandHomePrefix(trimmedRoot) : trimmedRoot;
    if (expandedRoot.startsWith("~")) {
      continue;
    }
    const normalizedRoot = path.resolve(expandedRoot);
    if (!roots.includes(normalizedRoot)) {
      roots.push(normalizedRoot);
    }
  }
}

export function getAgentScopedMediaLocalRoots(
  cfg: OpenClawConfig,
  agentId?: string,
  options: ResolveMediaLocalRootsOptions = {},
): readonly string[] {
  const roots = buildMediaLocalRoots(resolveStateDir());
  appendConfiguredMediaLocalRoots(roots, cfg, options);
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
