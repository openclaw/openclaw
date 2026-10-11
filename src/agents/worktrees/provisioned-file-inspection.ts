import fs from "node:fs/promises";
import path from "node:path";
import { lstatIfExists } from "./git.js";

type DirectoryIdentity = { path: string; dev: number; ino: number };

export async function captureParentDirectoryIdentities(
  root: string,
  relativePath: string,
): Promise<DirectoryIdentity[]> {
  const directories = [root];
  let current = root;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    directories.push(current);
  }
  const identities: DirectoryIdentity[] = [];
  for (const directory of directories) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`unsafe provisioned parent directory: ${directory}`);
    }
    identities.push({ path: directory, dev: stat.dev, ino: stat.ino });
  }
  return identities;
}

export async function validateDirectoryIdentities(identities: readonly DirectoryIdentity[]) {
  for (const identity of identities) {
    const stat = await fs.lstat(identity.path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== identity.dev ||
      stat.ino !== identity.ino
    ) {
      throw new Error(`provisioned parent directory changed: ${identity.path}`);
    }
  }
}

export function normalizeProvisionedRelativePath(relativePath: string): string | undefined {
  if (path.isAbsolute(relativePath)) {
    return undefined;
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return undefined;
  }
  return relativePath;
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
    const stat = await lstatIfExists(current);
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
      return false;
    }
  }
  return true;
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
