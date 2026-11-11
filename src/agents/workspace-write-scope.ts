import fs from "node:fs";
import asyncFs from "node:fs/promises";
import path from "node:path";
import { resolvePathPrefixSync } from "@openclaw/fs-safe/advanced";
import { hasErrnoCode } from "../infra/errno.js";
import { isPathInside } from "../infra/path-guards.js";

function canonicalPath(filePath: string): string {
  const { existingPath, unresolvedSegments } = resolvePathPrefixSync(filePath);
  return path.resolve(existingPath, ...unresolvedSegments);
}

type WorkspaceReads<T> = Generator<string, T, string>;
type Repository = {
  directory: string;
  gitFile: string;
  gitDir: string;
  commonDir: string;
  linked: boolean;
};

function* findRepository(start: string): WorkspaceReads<Repository | undefined> {
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
      const gitContents = yield gitFile;
      const pointer = /^gitdir: (.+)$/.exec(gitContents.trim())?.[1];
      if (!pointer) {
        return undefined;
      }
      const gitDirPath = path.resolve(directory, pointer);
      const gitDir = fs.realpathSync(gitDirPath);
      const commonFile = path.join(gitDir, "commondir");
      const commonContents = yield commonFile;
      const commonPath = path.resolve(gitDir, commonContents.trim());
      const commonDir = fs.realpathSync(commonPath);
      return { directory, gitFile, gitDir, commonDir, linked: true };
    } catch {
      return undefined;
    }
  }
}

function* isRegisteredWorktree(repository: Repository): WorkspaceReads<boolean> {
  if (path.dirname(repository.gitDir) !== path.join(repository.commonDir, "worktrees")) {
    return false;
  }
  try {
    const backpointer = path.join(repository.gitDir, "gitdir");
    const contents = yield backpointer;
    const registeredPath = path.resolve(repository.gitDir, contents.trim());
    const registeredGitFile = fs.realpathSync(registeredPath);
    const gitFile = fs.realpathSync(repository.gitFile);
    return registeredGitFile === gitFile;
  } catch {
    // Missing, stale, or forged registration never expands the admitted root.
    return false;
  }
}

function* selectHostWorkspaceRoot(root: string, absolutePath: string): WorkspaceReads<string> {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(absolutePath);
  // Resolve parents without following the final entry: unlink may remove a symlink.
  const canonicalTarget = path.join(canonicalPath(path.dirname(target)), path.basename(target));
  const repository = yield* findRepository(canonicalPath(resolvedRoot));
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
    (repository.linked && !(yield* isRegisteredWorktree(repository)))
  ) {
    return resolvedRoot;
  }
  const candidate = yield* findRepository(canonicalTarget);
  if (
    !candidate?.linked ||
    candidate.commonDir !== repository.commonDir ||
    !(yield* isRegisteredWorktree(candidate))
  ) {
    return resolvedRoot;
  }
  return candidate.directory;
}

/** Mutation effects require current registration inside fs-safe's synchronous guard. */
export function resolveHostWorkspaceRoot(root: string, absolutePath: string): string {
  const reads = selectHostWorkspaceRoot(root, absolutePath);
  let step = reads.next();
  while (!step.done) {
    let contents: string;
    try {
      contents = fs.readFileSync(step.value, "utf8");
    } catch (error) {
      step = reads.throw(error);
      continue;
    }
    step = reads.next(contents);
  }
  return step.value;
}

/** Git contents are async here; stat, realpath and fs-safe prefix traversal remain sync. */
export async function resolveHostRootAsync(root: string, absolutePath: string): Promise<string> {
  const reads = selectHostWorkspaceRoot(root, absolutePath);
  let step = reads.next();
  while (!step.done) {
    let contents: string;
    try {
      contents = await asyncFs.readFile(step.value, "utf8");
    } catch (error) {
      step = reads.throw(error);
      continue;
    }
    step = reads.next(contents);
  }
  return step.value;
}
