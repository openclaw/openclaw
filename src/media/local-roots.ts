// Local media root helpers normalize and match allowed local media roots.
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import {
  resolveEffectiveToolFsRootExpansionAllowed,
  resolveEffectiveToolFsWorkspaceOnly,
} from "../agents/tool-fs-policy.js";
import { resolveDeliveryQueueMediaDir, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { resolveConfigDir } from "../utils.js";
import { resolveLocalMediaPath } from "./local-media-path.js";

type BuildMediaLocalRootsOptions = {
  preferredTmpDir?: string;
};

let cachedPreferredTmpDir: string | undefined;

function resolveCachedPreferredTmpDir(): string {
  if (!cachedPreferredTmpDir) {
    // Temp-root discovery can hit platform/env state; keep one process-local
    // snapshot so media root lists stay stable during a run.
    cachedPreferredTmpDir = resolvePreferredOpenClawTmpDir();
  }
  return cachedPreferredTmpDir;
}

/** Builds the baseline local media root allowlist from state/config directories. */
function buildMediaLocalRoots(
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
      // Queue-owned copies of undelivered attachments. Recovery replays in a
      // process that never saw the original source, so it must be able to read
      // this root; only the spool dir is granted, never the state dir at large.
      resolveDeliveryQueueMediaDir(resolvedStateDir),
      path.join(resolvedStateDir, "canvas"),
      path.join(resolvedStateDir, "workspace"),
      path.join(resolvedStateDir, "sandboxes"),
    ]),
  );
}

/** Returns the process default roots where local media reads may resolve generated/cache files. */
export function getDefaultMediaLocalRoots(): readonly string[] {
  return buildMediaLocalRoots(resolveStateDir(), resolveConfigDir());
}

/**
 * Drops shared isolation parents from a media root list.
 *
 * Roots overlapping the shared `<state>/sandboxes` parent are removed unless they live inside the
 * supplied session workspace, so sibling sandboxes and the shared parent itself never re-enter the
 * allowlist through base construction or source-parent expansion. The shared `<state>/workspace`
 * parent is removed only when the caller supplies a session workspace outside it (a sandboxed
 * session); callers without session context keep the legacy shared-workspace grant.
 */
function filterSharedMediaLocalRoots(
  roots: readonly string[],
  context: { resolvedStateDir: string; sessionWorkspaceDir?: string },
): string[] {
  const sandboxesDir = path.join(context.resolvedStateDir, "sandboxes");
  const workspaceDir = path.join(context.resolvedStateDir, "workspace");
  const sessionWorkspaceDir = context.sessionWorkspaceDir
    ? path.resolve(context.sessionWorkspaceDir)
    : undefined;
  const isInsideOrEqual = (parent: string, child: string): boolean =>
    child === parent || isPathInside(parent, child);
  // The shared sandboxes parent itself (or any ancestor of it) is never a valid session workspace:
  // passing it must not re-admit the shared sandbox tree.
  const validSessionWorkspaceDir =
    sessionWorkspaceDir !== undefined && !isInsideOrEqual(sessionWorkspaceDir, sandboxesDir)
      ? sessionWorkspaceDir
      : undefined;
  const overlaps = (sharedDir: string, root: string): boolean =>
    isInsideOrEqual(sharedDir, root) || isInsideOrEqual(root, sharedDir);
  const filtered: string[] = [];
  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    const withinSessionWorkspace =
      validSessionWorkspaceDir !== undefined &&
      isInsideOrEqual(validSessionWorkspaceDir, resolvedRoot);
    if (overlaps(sandboxesDir, resolvedRoot) && !withinSessionWorkspace) {
      continue;
    }
    if (
      sessionWorkspaceDir !== undefined &&
      overlaps(workspaceDir, resolvedRoot) &&
      !withinSessionWorkspace
    ) {
      continue;
    }
    filtered.push(resolvedRoot);
  }
  return filtered;
}

/**
 * Default local media roots with shared isolation parents removed.
 *
 * Inbound attachment processing must not inherit sibling-sandbox grants from the process default
 * list; callers re-add their own session/agent workspace explicitly when one applies.
 */
export function getSessionSafeDefaultMediaLocalRoots(
  sessionWorkspaceDir?: string,
): readonly string[] {
  return filterSharedMediaLocalRoots(getDefaultMediaLocalRoots(), {
    resolvedStateDir: path.resolve(resolveStateDir()),
    sessionWorkspaceDir,
  });
}

/**
 * Adds exact agent/session workspaces without exposing shared agent or sandbox roots.
 *
 * Callers that need to send media from a sandbox must pass the authoritative active
 * session workspace, not a path derived from the requested media source. Omitting that
 * context intentionally denies sandbox files under workspace-only filesystem policy.
 */
export function getAgentScopedMediaLocalRoots(
  cfg: OpenClawConfig,
  agentId?: string,
  sessionWorkspaceDir?: string,
): readonly string[] {
  const stateDir = resolveStateDir();
  const resolvedStateDir = path.resolve(stateDir);
  const roots = filterSharedMediaLocalRoots(buildMediaLocalRoots(stateDir, resolveConfigDir()), {
    resolvedStateDir,
    sessionWorkspaceDir,
  });
  const normalizedAgentId = normalizeOptionalString(agentId);
  const workspaceDir =
    normalizeOptionalString(sessionWorkspaceDir) ??
    (normalizedAgentId ? resolveAgentWorkspaceDir(cfg, normalizedAgentId) : undefined);
  if (!workspaceDir) {
    return roots;
  }
  const normalizedWorkspaceDir = path.resolve(workspaceDir);
  if (normalizedWorkspaceDir === path.join(resolvedStateDir, "sandboxes")) {
    return roots;
  }
  if (!roots.includes(normalizedWorkspaceDir)) {
    roots.push(normalizedWorkspaceDir);
  }
  return roots;
}

/** Adds only concrete local source parent directories to an existing root allowlist. */
export function appendLocalMediaParentRoots(
  roots: readonly string[],
  mediaSources?: readonly string[],
): string[] {
  const appended = uniqueStrings(roots.map((root) => path.resolve(root)));
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
    if (!appended.includes(normalizedParent)) {
      appended.push(normalizedParent);
    }
  }
  return appended;
}

/**
 * Resolves outbound media roots, expanding for local sources only when filesystem policy allows it.
 * Pass `sessionWorkspaceDir` from trusted session context to retain access to that exact sandbox.
 */
export function getAgentScopedMediaLocalRootsForSources(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  mediaSources?: readonly string[];
  sessionWorkspaceDir?: string;
}): readonly string[] {
  const roots = getAgentScopedMediaLocalRoots(
    params.cfg,
    params.agentId,
    params.sessionWorkspaceDir,
  );
  if (resolveEffectiveToolFsWorkspaceOnly({ cfg: params.cfg, agentId: params.agentId })) {
    return roots;
  }
  if (!resolveEffectiveToolFsRootExpansionAllowed({ cfg: params.cfg, agentId: params.agentId })) {
    return roots;
  }
  const expanded = appendLocalMediaParentRoots(roots, params.mediaSources);
  // Source-parent expansion must not re-promote shared isolation parents (a shared workspace or
  // sibling sandbox must not become readable just because the caller named a file there).
  const addedParents = expanded.filter((root) => !roots.includes(root));
  const confinedParents = filterSharedMediaLocalRoots(addedParents, {
    resolvedStateDir: path.resolve(resolveStateDir()),
    sessionWorkspaceDir: params.sessionWorkspaceDir,
  });
  if (confinedParents.length === addedParents.length) {
    return expanded;
  }
  return Array.from(new Set([...roots, ...confinedParents]));
}
