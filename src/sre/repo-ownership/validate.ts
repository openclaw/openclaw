import path from "node:path";
import type { LoadedRepoOwnershipMap, RepoOwnershipMap } from "./types.js";

type RepoOwnershipValidationTarget = RepoOwnershipMap | LoadedRepoOwnershipMap;

function normalizeOwnedGlob(glob: string): string {
  return glob.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function isSupportedOwnedGlob(glob: string): boolean {
  return (
    glob.length > 0 &&
    !glob.startsWith("/") &&
    !glob.startsWith("../") &&
    !glob.endsWith("/") &&
    /^[A-Za-z0-9*?._@/-]+$/.test(glob)
  );
}

function expandGlobPrefix(glob: string): string | null {
  if (glob === "**") {
    return "";
  }
  if (glob.endsWith("/**")) {
    return glob.slice(0, -3);
  }
  return null;
}

function globsOverlap(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }

  const leftPrefix = expandGlobPrefix(left);
  if (leftPrefix !== null && (right === leftPrefix || right.startsWith(`${leftPrefix}/`))) {
    return true;
  }

  const rightPrefix = expandGlobPrefix(right);
  if (rightPrefix !== null && (left === rightPrefix || left.startsWith(`${rightPrefix}/`))) {
    return true;
  }

  return false;
}

function normalizeLocalPath(localPath: string): string {
  return path.resolve(localPath);
}

export function validateRepoOwnershipMap(
  map: RepoOwnershipValidationTarget,
): RepoOwnershipValidationTarget {
  const issues: string[] = [];
  const repoIds = new Set<string>();
  const localPaths = new Map<string, string>();
  const crossRepoGlobs = new Map<string, string>();

  for (const repo of map.repos) {
    if (!repo.repoId.trim()) {
      issues.push("repoOwnership.repos[].repoId must be non-empty");
      continue;
    }
    if (repoIds.has(repo.repoId)) {
      issues.push(`duplicate repoOwnership repoId: ${repo.repoId}`);
    }
    repoIds.add(repo.repoId);

    const normalizedLocalPath = normalizeLocalPath(
      "resolvedLocalPath" in repo ? repo.resolvedLocalPath : repo.localPath,
    );
    const existingRepoId = localPaths.get(normalizedLocalPath);
    if (existingRepoId && existingRepoId !== repo.repoId) {
      issues.push(
        `duplicate repoOwnership localPath: ${repo.repoId} and ${existingRepoId} both use ${normalizedLocalPath}`,
      );
    }
    localPaths.set(normalizedLocalPath, repo.repoId);

    if (repo.ownedGlobs.length === 0) {
      issues.push(`repoOwnership ${repo.repoId} must declare at least one owned glob`);
    }

    for (const rawGlob of repo.ownedGlobs) {
      const glob = normalizeOwnedGlob(rawGlob);
      if (!isSupportedOwnedGlob(glob)) {
        issues.push(`invalid repoOwnership glob for ${repo.repoId}: ${rawGlob}`);
        continue;
      }

      for (const [existingGlob, existingRepoIdForGlob] of crossRepoGlobs.entries()) {
        if (existingRepoIdForGlob === repo.repoId) {
          continue;
        }
        if (globsOverlap(existingGlob, glob)) {
          issues.push(
            `overlapping repoOwnership globs: ${existingRepoIdForGlob}:${existingGlob} overlaps ${repo.repoId}:${glob}`,
          );
        }
      }

      crossRepoGlobs.set(glob, repo.repoId);
    }
  }

  if (issues.length > 0) {
    throw new Error(issues.join("\n"));
  }

  return map;
}

export const __test__ = {
  globsOverlap,
  normalizeOwnedGlob,
};
