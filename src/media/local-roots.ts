import os from "node:os";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { resolveIMessageAttachmentRoots } from "./inbound-path-policy.js";

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
  return roots;
}

function materializeRootPatternForHome(rootPattern: string, homeDir: string): string | undefined {
  if (!rootPattern.includes("*")) {
    return path.posix.normalize(rootPattern);
  }
  const normalizedHome = path.posix.normalize(homeDir.replaceAll("\\", "/"));
  const homeSegments = normalizedHome.split("/").filter(Boolean);
  const patternSegments = rootPattern.split("/").filter(Boolean);
  const wildcardIndex = patternSegments.indexOf("*");
  if (wildcardIndex < 0 || patternSegments.includes("*", wildcardIndex + 1)) {
    return undefined;
  }
  if (wildcardIndex >= homeSegments.length) {
    return undefined;
  }
  for (let idx = 0; idx < wildcardIndex; idx += 1) {
    if (patternSegments[idx] !== homeSegments[idx]) {
      return undefined;
    }
  }
  const materializedSegments = [...patternSegments];
  materializedSegments[wildcardIndex] = homeSegments[wildcardIndex];
  return `/${materializedSegments.join("/")}`;
}

export function getChannelScopedMediaLocalRoots(params: {
  cfg: OpenClawConfig | undefined;
  channel?: string;
  accountId?: string;
}): readonly string[] {
  const normalizedChannel = normalizeMessageChannel(params.channel);
  if (normalizedChannel !== "imessage" || !params.cfg) {
    return [];
  }
  const homeDir = os.homedir();
  const roots = resolveIMessageAttachmentRoots({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const materialized = roots
    .map((root) => materializeRootPatternForHome(root, homeDir))
    .filter((root): root is string => typeof root === "string" && root.length > 0);
  return Array.from(new Set(materialized));
}

export const __testing = {
  materializeRootPatternForHome,
};
