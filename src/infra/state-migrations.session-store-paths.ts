import fs from "node:fs";
import path from "node:path";
import { hasErrnoCode } from "./errno.js";
import { sameFileIdentity } from "./fs-safe-advanced.js";
import type { SessionStoreAliasPlan } from "./state-migrations.types.js";

type SessionStorePathRelationship = "same" | "different" | "unknown";

function resolveSessionStorePathRelationship(
  left: string,
  right: string,
): SessionStorePathRelationship {
  if (left === right) {
    return "same";
  }
  try {
    return sameFileIdentity(
      fs.statSync(left, { bigint: true }),
      fs.statSync(right, { bigint: true }),
    )
      ? "same"
      : "different";
  } catch (err) {
    if (!hasErrnoCode(err, "ENOENT") && !hasErrnoCode(err, "ENOTDIR")) {
      return "unknown";
    }
    const resolvedLeft = resolvePathThroughExistingParents(left);
    const resolvedRight = resolvePathThroughExistingParents(right);
    if (resolvedLeft === undefined || resolvedRight === undefined) {
      return "unknown";
    }
    return resolvedLeft === resolvedRight ? "same" : "different";
  }
}

export function sessionStorePathsMatch(left: string, right: string): boolean {
  // Ownership checks must fail closed: an inaccessible path may still alias the
  // readable store, so preserve shared-owner policy until identity is known.
  return resolveSessionStorePathRelationship(left, right) !== "different";
}

function resolvePathThroughExistingParents(filePath: string): string | undefined {
  const resolvedPath = path.resolve(filePath);
  const suffix = [path.basename(resolvedPath)];
  let parentPath = path.dirname(resolvedPath);
  while (true) {
    try {
      return path.join(fs.realpathSync.native(parentPath), ...suffix);
    } catch (err) {
      if (!hasErrnoCode(err, "ENOENT") && !hasErrnoCode(err, "ENOTDIR")) {
        return undefined;
      }
      const nextParent = path.dirname(parentPath);
      if (nextParent === parentPath) {
        return undefined;
      }
      suffix.unshift(path.basename(parentPath));
      parentPath = nextParent;
    }
  }
}

function sessionStorePathIsFinalSymlink(storePath: string): boolean {
  try {
    return fs.lstatSync(storePath).isSymbolicLink();
  } catch {
    return false;
  }
}

function sessionStorePathsHaveDistinctEntries(left: string, right: string): boolean {
  if (left === right) {
    return false;
  }
  try {
    // Replacing a final-component symlink splits it from its target. Parent
    // symlink spellings are safe because both names still address one entry.
    if (fs.lstatSync(left).isSymbolicLink() || fs.lstatSync(right).isSymbolicLink()) {
      return true;
    }
    // Hard links resolve to distinct pathnames and split on replacement.
    return fs.realpathSync.native(left) !== fs.realpathSync.native(right);
  } catch (err) {
    if (!hasErrnoCode(err, "ENOENT") && !hasErrnoCode(err, "ENOTDIR")) {
      return true;
    }
    const resolvedLeft = resolvePathThroughExistingParents(left);
    const resolvedRight = resolvePathThroughExistingParents(right);
    return resolvedLeft === undefined || resolvedLeft !== resolvedRight;
  }
}

export function resolveSessionStoreAliasPlan(
  storePath: string,
  candidatePaths: Iterable<string>,
): SessionStoreAliasPlan {
  let hasDistinctEntries = false;
  let hasFinalSymlink = sessionStorePathIsFinalSymlink(storePath);
  let hasUnresolvedIdentity = false;
  for (const candidatePath of candidatePaths) {
    const relationship = resolveSessionStorePathRelationship(storePath, candidatePath);
    if (relationship === "different") {
      continue;
    }
    if (relationship === "unknown") {
      hasUnresolvedIdentity = true;
      continue;
    }
    hasFinalSymlink ||= sessionStorePathIsFinalSymlink(candidatePath);
    if (sessionStorePathsHaveDistinctEntries(storePath, candidatePath)) {
      hasDistinctEntries = true;
    }
  }
  return {
    hasDistinctAliases: hasFinalSymlink || hasDistinctEntries || hasUnresolvedIdentity,
    hasFinalSymlink,
    hasUnresolvedIdentity,
  };
}
