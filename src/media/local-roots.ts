import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import {
  resolveEffectiveToolFsRootExpansionAllowed,
  resolveToolFsConfig,
} from "../agents/tool-fs-policy.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { safeFileURLToPath } from "../infra/local-file-access.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveConfigDir, resolveUserPath } from "../utils.js";
import { type LocalMediaRoot, resolveLocalMediaRootPath } from "./local-media-root.js";
import { isPassThroughRemoteMediaSource } from "./media-source-url.js";

type BuildMediaLocalRootsOptions = {
  preferredTmpDir?: string;
};

type AgentScopedMediaRootsOptions = {
  ignoreConfiguredRoots?: boolean;
};

let cachedPreferredTmpDir: string | undefined;
const DATA_URL_RE = /^data:/i;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;

function resolveCachedPreferredTmpDir(): string {
  if (!cachedPreferredTmpDir) {
    cachedPreferredTmpDir = resolvePreferredOpenClawTmpDir();
  }
  return cachedPreferredTmpDir;
}

export function buildMediaLocalRoots(
  stateDir: string,
  configDir: string,
  options: BuildMediaLocalRootsOptions = {},
): string[] {
  const resolvedStateDir = path.resolve(stateDir);
  const resolvedConfigDir = path.resolve(configDir);
  const preferredTmpDir = options.preferredTmpDir ?? resolveCachedPreferredTmpDir();
  return Array.from(
    new Set([
      preferredTmpDir,
      path.join(resolvedConfigDir, "media"),
      path.join(resolvedStateDir, "media"),
      path.join(resolvedStateDir, "canvas"),
      path.join(resolvedStateDir, "workspace"),
      path.join(resolvedStateDir, "sandboxes"),
    ]),
  );
}

export function getDefaultMediaLocalRoots(): readonly string[] {
  return buildMediaLocalRoots(resolveStateDir(), resolveConfigDir());
}

function getAgentScopedMediaLocalRootsInternal(
  cfg: OpenClawConfig,
  agentId?: string,
  options?: AgentScopedMediaRootsOptions,
): readonly LocalMediaRoot[] {
  const fsConfig = resolveToolFsConfig({ cfg, agentId });
  if (!options?.ignoreConfiguredRoots && fsConfig.roots !== undefined) {
    return fsConfig.roots.map((root) => ({
      path: path.resolve(root.path),
      kind: root.kind,
      access: root.access,
    }));
  }
  const roots = buildMediaLocalRoots(resolveStateDir(), resolveConfigDir());
  const normalizedAgentId = normalizeOptionalString(agentId);
  if (!normalizedAgentId) {
    return roots;
  }
  const workspaceDir = resolveAgentWorkspaceDir(cfg, normalizedAgentId);
  if (!workspaceDir) {
    return roots;
  }
  const normalizedWorkspaceDir = path.resolve(workspaceDir);
  if (!roots.includes(normalizedWorkspaceDir)) {
    roots.push(normalizedWorkspaceDir);
  }
  return roots;
}

export function getAgentScopedMediaLocalRootEntries(
  cfg: OpenClawConfig,
  agentId?: string,
): readonly LocalMediaRoot[] {
  return getAgentScopedMediaLocalRootsInternal(cfg, agentId);
}

export function getAgentScopedMediaLocalRoots(
  cfg: OpenClawConfig,
  agentId?: string,
): readonly string[] {
  return getAgentScopedMediaLocalRootsInternal(cfg, agentId).map(resolveLocalMediaRootPath);
}

function resolveLocalMediaPath(source: string): string | undefined {
  const trimmed = source.trim();
  if (!trimmed || isPassThroughRemoteMediaSource(trimmed) || DATA_URL_RE.test(trimmed)) {
    return undefined;
  }
  if (trimmed.startsWith("file://")) {
    try {
      return safeFileURLToPath(trimmed);
    } catch {
      return undefined;
    }
  }
  if (trimmed.startsWith("~")) {
    return resolveUserPath(trimmed);
  }
  if (
    path.isAbsolute(trimmed) ||
    (process.platform === "win32" && WINDOWS_DRIVE_RE.test(trimmed))
  ) {
    return path.resolve(trimmed);
  }
  return undefined;
}

export function appendLocalMediaParentRoots(
  roots: readonly string[],
  mediaSources?: readonly string[],
): string[] {
  return appendLocalMediaParentRootEntries(roots, mediaSources).map(resolveLocalMediaRootPath);
}

function normalizeLocalMediaRoot(root: LocalMediaRoot): LocalMediaRoot {
  if (typeof root === "string") {
    return path.resolve(root);
  }
  return { ...root, path: path.resolve(root.path) };
}

export function appendLocalMediaParentRootEntries(
  roots: readonly LocalMediaRoot[],
  mediaSources?: readonly string[],
): LocalMediaRoot[] {
  const appended = Array.from(
    new Map(
      roots.map((root) => {
        const normalized = normalizeLocalMediaRoot(root);
        return [resolveLocalMediaRootPath(normalized), normalized] as const;
      }),
    ).values(),
  );
  const appendedPaths = new Set(
    appended.map((root) => path.resolve(resolveLocalMediaRootPath(root))),
  );
  for (const source of mediaSources ?? []) {
    const localPath = resolveLocalMediaPath(source);
    if (!localPath) {
      continue;
    }
    const parentDir = path.dirname(localPath);
    if (parentDir === path.parse(parentDir).root) {
      continue;
    }
    const normalizedParent = path.resolve(parentDir);
    if (!appendedPaths.has(normalizedParent)) {
      appended.push(normalizedParent);
      appendedPaths.add(normalizedParent);
    }
  }
  return appended;
}

export function getAgentScopedMediaLocalRootsForSources(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  mediaSources?: readonly string[];
  ignoreConfiguredRoots?: boolean;
}): readonly string[] {
  const fsConfig = resolveToolFsConfig({ cfg: params.cfg, agentId: params.agentId });
  const roots = getAgentScopedMediaLocalRootsInternal(params.cfg, params.agentId, {
    ignoreConfiguredRoots: params.ignoreConfiguredRoots,
  }).map(resolveLocalMediaRootPath);
  if (fsConfig.roots !== undefined && !params.ignoreConfiguredRoots) {
    return roots;
  }
  const fallbackRoots = [...roots];
  if (fsConfig.workspaceOnly) {
    return fallbackRoots;
  }
  if (!resolveEffectiveToolFsRootExpansionAllowed({ cfg: params.cfg, agentId: params.agentId })) {
    return fallbackRoots;
  }
  return appendLocalMediaParentRoots(fallbackRoots, params.mediaSources);
}
