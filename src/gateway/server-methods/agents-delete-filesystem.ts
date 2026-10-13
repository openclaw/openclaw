import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePathPrefixSync } from "@openclaw/fs-safe/advanced";
import type { AgentsDeleteResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { normalizeAgentDirRegistryPath } from "../../agents/agent-dir-registry.js";
import type { AgentDeletionOperation } from "../../agents/agent-lifecycle-registry.js";
import { trashAllowedRoots } from "../../commands/cleanup-utils.js";
import { isMissingPathError } from "../../infra/errors.js";
import { root, FsSafeError } from "../../infra/fs-safe.js";
import { isPathInside } from "../../infra/path-guards.js";
import { movePathToTrash } from "../../plugin-sdk/browser-maintenance.js";
import type { AgentDeletionJournalCleanupPath } from "../../state/agent-deletion-journal.js";

type AgentDeleteRemovedPath = NonNullable<AgentsDeleteResult["removed"]>[number];
type AgentDeleteFailedPath = NonNullable<AgentsDeleteResult["failed"]>[number];

type AgentDeletePathOutcome =
  | { removed: AgentDeleteRemovedPath }
  | { skipped: AgentDeleteFailedPath }
  | { failed: AgentDeleteFailedPath };

export class AgentCleanupIdentityMismatchError extends Error {}
export function cleanupFailure(pathname: string, error: unknown): AgentDeletePathOutcome {
  const reason = error instanceof Error && error.message ? error.message : String(error);
  return { failed: { path: pathname, reason: reason || "unknown error" } };
}

function cleanupPathIdentity(stat: { dev?: number | bigint; ino?: number | bigint } | undefined) {
  if (
    (typeof stat?.dev !== "number" && typeof stat?.dev !== "bigint") ||
    (typeof stat.ino !== "number" && typeof stat.ino !== "bigint")
  ) {
    return null;
  }
  const dev = Number(stat.dev);
  const ino = Number(stat.ino);
  if (!Number.isSafeInteger(dev) || !Number.isSafeInteger(ino)) {
    throw new Error("cleanup path identity exceeds the safe integer range");
  }
  return { dev, ino };
}

export async function statAgentCleanupPath(cleanupPath: AgentDeleteCleanupPath) {
  const parentPath = cleanupPath.parentPath;
  const parentRoot = await root(parentPath, {
    hardlinks: "reject",
    symlinks: "reject",
  });
  if (path.resolve(parentRoot.rootReal) !== parentPath) {
    throw new FsSafeError("path-mismatch", "cleanup path parent changed before deletion");
  }
  const stat = await parentRoot.stat(path.basename(cleanupPath.trashPath));
  const isSymlink = stat.isSymbolicLink;
  if (isSymlink !== (cleanupPath.kind === "symlink")) {
    throw new AgentCleanupIdentityMismatchError(
      `cleanup path changed from ${cleanupPath.kind} before deletion`,
    );
  }
  if (stat.isFile && stat.nlink > 1) {
    throw new AgentCleanupIdentityMismatchError("hardlinked cleanup replacement preserved");
  }
  const identity = cleanupPathIdentity(stat);
  if (cleanupPath.preparedIdentity === null) {
    // The journal fence blocks legitimate claims on prepared-absent paths, so a
    // file that appeared here is leaked deleted-agent state (recreated WAL
    // sidecars, runtime home rewrites). Adopt it and sweep it; preserving it
    // cascades ancestor protection and finishes over a surviving tree.
    cleanupPath.preparedIdentity = identity;
  } else if (
    identity === null ||
    identity.dev !== cleanupPath.preparedIdentity.dev ||
    identity.ino !== cleanupPath.preparedIdentity.ino
  ) {
    throw new AgentCleanupIdentityMismatchError("cleanup path identity changed before deletion");
  }
}

export async function removeAgentPath(
  cleanupPath: AgentDeleteCleanupPath,
  deletion: AgentDeletionOperation,
): Promise<AgentDeletePathOutcome> {
  const pathname = cleanupPath.path;
  const trashPath = cleanupPath.trashPath;
  try {
    await statAgentCleanupPath(cleanupPath);
  } catch (error) {
    if (error instanceof AgentCleanupIdentityMismatchError) {
      return { skipped: { path: pathname, reason: error.message } };
    }
    return isMissingPathError(error)
      ? { removed: { path: pathname, method: "missing" } }
      : cleanupFailure(pathname, error);
  }
  try {
    // fs-safe pins traversal and identity for validation; Trash has no fd-relative move API, so
    // replacement after this check and before its rename is the accepted residual race bound.
    // statAgentCleanupPath verified the declared parent; fs-safe's default roots (home/tmp)
    // alone refuse every path of a volume-backed state dir. Keep those defaults so the
    // directory behind a workspace symlink stays fenced exactly as shipped, while the link
    // itself may always move (accepted edge: a link target beside its link is trashed too).
    deletion.assertCurrentFinal();
    await movePathToTrash(trashPath, {
      allowedRoots: [
        ...trashAllowedRoots(
          cleanupPath.sourcePaths,
          cleanupPath.kind === "symlink" ? cleanupPath.canonicalPath : undefined,
        ),
        os.homedir(),
        os.tmpdir(),
      ],
    });
    return { removed: { path: pathname, method: "trash" } };
  } catch (error) {
    if (!isMissingPathError(error)) {
      return cleanupFailure(pathname, error);
    }
    try {
      await statAgentCleanupPath(cleanupPath);
      return cleanupFailure(pathname, error);
    } catch (statError) {
      return isMissingPathError(statError)
        ? { removed: { path: pathname, method: "missing" } }
        : cleanupFailure(pathname, statError);
    }
  }
}

export type AgentDeleteCleanupPath = {
  path: string;
  parentPath: string;
  canonicalPath: string;
  trashPath: string;
  trashCoversDescendants: boolean;
  kind: "target" | "symlink";
  preparedIdentity: { dev: number; ino: number } | null;
  done: boolean;
  note?: string;
  preparationError?: unknown;
  sourcePaths: string[];
};

async function resolveAgentDeleteCleanupTarget(pathname: string): Promise<string> {
  const candidate = path.resolve(pathname);
  try {
    return await fs.realpath(candidate);
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
    const { existingPath, unresolvedSegments } = resolvePathPrefixSync(candidate);
    return path.resolve(existingPath, ...unresolvedSegments);
  }
}

export async function prepareAgentDeleteCleanupPaths(
  paths: readonly string[],
  persistedPaths: readonly AgentDeletionJournalCleanupPath[] = [],
): Promise<AgentDeleteCleanupPath[]> {
  const uniquePaths = new Map<string, AgentDeleteCleanupPath>();
  const addPath = (candidate: AgentDeleteCleanupPath) => {
    const existing = uniquePaths.get(candidate.trashPath);
    if (!existing) {
      uniquePaths.set(candidate.trashPath, candidate);
      return;
    }
    existing.sourcePaths = [...new Set([...existing.sourcePaths, ...candidate.sourcePaths])];
    existing.done ||= candidate.done;
    existing.note ??= candidate.note;
    existing.preparationError ??= candidate.preparationError;
    if (candidate.kind === "target") {
      existing.kind = "target";
      existing.canonicalPath = candidate.canonicalPath;
      existing.parentPath = candidate.parentPath;
      existing.trashCoversDescendants ||= candidate.trashCoversDescendants;
    }
  };
  for (const persistedPath of persistedPaths) {
    const journalPath = path.resolve(persistedPath.path);
    const trashPath = path.resolve(persistedPath.canonicalPath);
    addPath({
      path: journalPath,
      parentPath: path.resolve(persistedPath.parentPath),
      canonicalPath: normalizeAgentDirRegistryPath(trashPath),
      trashPath,
      trashCoversDescendants: persistedPath.coversDescendants,
      kind: persistedPath.kind,
      preparedIdentity:
        persistedPath.dev === null || persistedPath.ino === null
          ? null
          : { dev: persistedPath.dev, ino: persistedPath.ino },
      done: persistedPath.done,
      note: persistedPath.note,
      sourcePaths: persistedPath.sourcePaths.map((sourcePath) => path.resolve(sourcePath)),
    });
  }
  for (const pathname of paths) {
    const sourcePath = path.resolve(pathname);
    let sourceParentPath = path.dirname(sourcePath);
    let resolvedPath = sourcePath;
    let preparationError: unknown;
    try {
      resolvedPath = await resolveAgentDeleteCleanupTarget(pathname);
      sourceParentPath = await resolveAgentDeleteCleanupTarget(path.dirname(sourcePath));
    } catch (error) {
      preparationError = error;
    }
    let sourceStat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
    try {
      sourceStat = await fs.lstat(pathname);
    } catch (error) {
      if (!isMissingPathError(error)) {
        preparationError ??= error;
      }
    }
    let targetStat = sourceStat;
    if (resolvedPath !== sourcePath) {
      try {
        targetStat = await fs.lstat(resolvedPath);
      } catch (error) {
        if (!isMissingPathError(error)) {
          preparationError ??= error;
        }
        targetStat = undefined;
      }
    }
    const canonicalPath = normalizeAgentDirRegistryPath(resolvedPath);
    addPath({
      path: resolvedPath,
      parentPath: path.dirname(resolvedPath),
      canonicalPath,
      trashPath: resolvedPath,
      trashCoversDescendants: targetStat ? !targetStat.isSymbolicLink() : false,
      kind: "target",
      preparedIdentity: cleanupPathIdentity(targetStat),
      done: false,
      preparationError,
      sourcePaths: [sourcePath],
    });
    if (sourceStat?.isSymbolicLink() && sourcePath !== resolvedPath) {
      addPath({
        path: sourcePath,
        parentPath: sourceParentPath,
        canonicalPath,
        trashPath: path.join(sourceParentPath, path.basename(sourcePath)),
        trashCoversDescendants: false,
        kind: "symlink",
        preparedIdentity: cleanupPathIdentity(sourceStat),
        done: false,
        sourcePaths: [sourcePath],
      });
    }
  }
  const depth = (pathname: string) =>
    path.relative(path.parse(pathname).root, pathname).split(path.sep).filter(Boolean).length;
  const cleanupDepth = (cleanupPath: AgentDeleteCleanupPath) =>
    Math.max(
      depth(cleanupPath.canonicalPath),
      depth(cleanupPath.trashPath),
      ...cleanupPath.sourcePaths.map(depth),
    );
  const compareFallback = (left: AgentDeleteCleanupPath, right: AgentDeleteCleanupPath) => {
    if (left.kind !== right.kind) {
      return left.kind === "target" ? -1 : 1;
    }
    const depthDifference = cleanupDepth(right) - cleanupDepth(left);
    if (depthDifference !== 0) {
      return depthDifference;
    }
    const trashDepth = depth(right.trashPath) - depth(left.trashPath);
    return trashDepth || left.trashPath.localeCompare(right.trashPath);
  };
  const mustPrecede = (left: AgentDeleteCleanupPath, right: AgentDeleteCleanupPath) => {
    if (left.kind !== right.kind) {
      return left.kind === "target";
    }
    if (isPathInside(right.trashPath, left.trashPath)) {
      return true;
    }
    if (isPathInside(left.trashPath, right.trashPath)) {
      return false;
    }
    const rightRoots = [right.trashPath, ...right.sourcePaths];
    return left.sourcePaths.some((leftSource) =>
      rightRoots.some((rightRoot) => isPathInside(rightRoot, leftSource)),
    );
  };
  const remaining = [...uniquePaths.values()].toSorted(compareFallback);
  const ordered: AgentDeleteCleanupPath[] = [];
  // Snapshot real targets and clean every physical or lexical descendant first; moving an
  // ancestor symlink would otherwise hide surviving child data and let recovery finalize.
  while (remaining.length > 0) {
    const nextIndex = remaining.findIndex((candidate, candidateIndex) =>
      remaining.every(
        (other, otherIndex) => otherIndex === candidateIndex || !mustPrecede(other, candidate),
      ),
    );
    ordered.push(...remaining.splice(Math.max(0, nextIndex), 1));
  }
  return ordered;
}

export function cleanupPathCovers(
  cleanupPath: AgentDeleteCleanupPath,
  targetPath: string,
  canonicalTargetPath: string,
): boolean {
  const trashTargetPath = path.resolve(targetPath);
  return (
    cleanupPath.sourcePaths.includes(trashTargetPath) ||
    cleanupPath.trashPath === trashTargetPath ||
    (cleanupPath.trashCoversDescendants &&
      (cleanupPath.kind === "target" || isPathInside(cleanupPath.trashPath, trashTargetPath)) &&
      isPathInside(cleanupPath.canonicalPath, canonicalTargetPath))
  );
}
