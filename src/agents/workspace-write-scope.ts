import fs from "node:fs";
import path from "node:path";
import { resolvePathPrefixSync } from "@openclaw/fs-safe/advanced";
import { hasErrnoCode } from "../infra/errno.js";
import { isPathInside } from "../infra/path-guards.js";

function canonicalPath(filePath: string): string {
  const { existingPath, unresolvedSegments } = resolvePathPrefixSync(filePath);
  return path.resolve(existingPath, ...unresolvedSegments);
}

function findRepository(start: string) {
  for (let directory = start; ; directory = path.dirname(directory)) {
    const gitFile = path.join(directory, ".git");
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(gitFile);
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT") && !hasErrnoCode(error, "ENOTDIR")) {
        return undefined;
      }
    }
    if (!stat) {
      if (path.dirname(directory) === directory) {
        return undefined;
      }
      continue;
    }
    try {
      if (stat.isDirectory()) {
        const commonDir = fs.realpathSync(gitFile);
        return { directory, gitFile, gitDir: commonDir, commonDir, linked: false };
      }
      if (!stat.isFile()) {
        return undefined;
      }
      const pointer = /^gitdir: (.+)$/.exec(fs.readFileSync(gitFile, "utf8").trim())?.[1];
      if (!pointer) {
        return undefined;
      }
      const gitDir = fs.realpathSync(path.resolve(directory, pointer));
      const commonDir = fs.realpathSync(
        path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim()),
      );
      return { directory, gitFile, gitDir, commonDir, linked: true };
    } catch {
      return undefined;
    }
  }
}

function isRegisteredWorktree(repository: NonNullable<ReturnType<typeof findRepository>>): boolean {
  if (path.dirname(repository.gitDir) !== path.join(repository.commonDir, "worktrees")) {
    return false;
  }
  try {
    const registeredGitFile = fs.realpathSync(
      path.resolve(
        repository.gitDir,
        fs.readFileSync(path.join(repository.gitDir, "gitdir"), "utf8").trim(),
      ),
    );
    return registeredGitFile === fs.realpathSync(repository.gitFile);
  } catch {
    // Missing, stale, or forged registration never expands the admitted root.
    return false;
  }
}

/** Select a host boundary from current Git registration, never a startup snapshot. */
export function resolveHostWorkspaceRoot(root: string, absolutePath: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(absolutePath);
  // Resolve parents without following the final entry: unlink may remove a symlink.
  const canonicalTarget = path.join(canonicalPath(path.dirname(target)), path.basename(target));
  const repository = findRepository(canonicalPath(resolvedRoot));
  if (
    [target, canonicalTarget].some((entry) =>
      entry.split(path.sep).some((segment) => segment.toLowerCase() === ".git"),
    ) ||
    (repository &&
      (isPathInside(repository.commonDir, canonicalTarget) ||
        isPathInside(repository.gitDir, canonicalTarget)))
  ) {
    throw new Error(`Git metadata is outside the writable workspace: ${absolutePath}`);
  }
  if (
    isPathInside(resolvedRoot, target) ||
    !repository ||
    (repository.linked && !isRegisteredWorktree(repository))
  ) {
    return resolvedRoot;
  }
  const candidate = findRepository(canonicalTarget);
  if (
    !candidate?.linked ||
    candidate.commonDir !== repository.commonDir ||
    !isRegisteredWorktree(candidate)
  ) {
    return resolvedRoot;
  }
  return candidate.directory;
}
