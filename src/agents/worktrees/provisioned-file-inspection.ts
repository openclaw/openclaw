import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../../infra/errno.js";

export function normalizeProvisionedRelativePath(relativePath: string): string | undefined {
  if (path.isAbsolute(relativePath)) {
    return undefined;
  }
  const segments = relativePath.split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return segments.join("/");
}

export function resolveGitPath(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split("/"));
}

export async function hasSafeParentDirectories(
  root: string,
  relativePath: string,
): Promise<boolean> {
  const segments = relativePath.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        return false;
      }
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
    }
  }
  return true;
}

export async function lstatIfExists(target: string) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

type ProvisionedFile = {
  path: string;
  target: string;
  mode: number | null;
};

export async function inspectProvisionedFiles(
  worktreePath: string,
  provisionedPaths: readonly string[] | undefined,
): Promise<ProvisionedFile[] | undefined> {
  if (provisionedPaths === undefined) {
    return undefined;
  }
  const files: ProvisionedFile[] = [];
  for (const relativePath of provisionedPaths) {
    const normalized = normalizeProvisionedRelativePath(relativePath);
    if (!normalized || !(await hasSafeParentDirectories(worktreePath, normalized))) {
      throw new Error(`unsafe provisioned path: ${relativePath}`);
    }
    const target = resolveGitPath(worktreePath, normalized);
    const stat = await lstatIfExists(target);
    if (!stat) {
      files.push({ path: normalized, target, mode: null });
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`provisioned path is no longer a regular file: ${relativePath}`);
    }
    files.push({ path: normalized, target, mode: stat.mode & 0o7777 });
  }
  return files.toSorted((a, b) => a.path.localeCompare(b.path));
}

export async function hasUnsnapshotableProvisionedFiles(
  worktreePath: string,
  provisionedPaths: readonly string[] | undefined,
): Promise<boolean> {
  try {
    return (await inspectProvisionedFiles(worktreePath, provisionedPaths)) === undefined;
  } catch {
    return true;
  }
}
