import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runGitBuffered } from "../../agents/worktrees/git.js";
import { FsSafeError, type Root } from "../../infra/fs-safe.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import type { createStagedInputPathMatcher } from "../../media/staged-inputs.js";
import { isManagedSandboxSkillsPath } from "../../shared/sandbox-workspace-paths.js";
import type { WorkspaceNode } from "./workspace-manifest-comparison.js";
import { computeWorkspaceFileSnapshot } from "./workspace-manifest-worker.js";
import {
  MAX_RECONCILIATION_FILE_BYTES,
  type WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import { isDerivedWorkspacePath } from "./workspace-path-exclusions.js";

const PATCH_TIMEOUT_MS = 10 * 60_000;

export function localPath(root: string, relative: string): string {
  return path.join(root, ...relative.split("/"));
}

export async function removeEmptyWorkspaceDirectory(root: Root, entryPath: string): Promise<void> {
  let children: string[];
  try {
    children = await root.list(entryPath);
  } catch (error) {
    if (error instanceof FsSafeError && ["not-found", "path-alias"].includes(error.code)) {
      return;
    }
    throw error;
  }
  if (children.length > 0) {
    // Conflicted descendants deliberately keep their containing directory
    // even when the cloud result removed that directory.
    return;
  }
  try {
    await root.remove(entryPath);
  } catch (error) {
    if (error instanceof FsSafeError && ["not-found", "path-alias"].includes(error.code)) {
      return;
    }
    const racedChildren = await root.list(entryPath).catch(() => undefined);
    if (racedChildren?.length) {
      return;
    }
    throw error;
  }
}

export async function localWorkspaceNode(root: string, entryPath: string): Promise<WorkspaceNode> {
  const absolute = localPath(root, entryPath);
  const stats = await fs.lstat(absolute).catch((error: unknown) => {
    if (hasNodeErrorCode(error, "ENOENT") || hasNodeErrorCode(error, "ENOTDIR")) {
      return undefined;
    }
    throw error;
  });
  if (!stats) {
    return undefined;
  }
  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    return { path: entryPath, type: "directory" };
  }
  if (stats.isSymbolicLink()) {
    return { path: entryPath, type: "symlink", mode: 0o777, target: await fs.readlink(absolute) };
  }
  if (!stats.isFile()) {
    return { path: entryPath, type: "unsupported" };
  }
  const snapshot = await computeWorkspaceFileSnapshot(
    absolute,
    MAX_RECONCILIATION_FILE_BYTES,
    root,
  );
  return { path: entryPath, ...snapshot };
}

async function fileEntryMatches(
  absolute: string,
  entry: Extract<WorkerWorkspaceManifestEntry, { type: "file" }>,
  root?: string,
): Promise<boolean> {
  const snapshot = await computeWorkspaceFileSnapshot(
    absolute,
    MAX_RECONCILIATION_FILE_BYTES,
    root,
  ).catch((error: unknown) => {
    if (error instanceof WorkerTaskError) {
      throw error;
    }
    return undefined;
  });
  return (
    snapshot?.type === "file" &&
    snapshot.mode === entry.mode &&
    snapshot.size === entry.size &&
    snapshot.sha256 === entry.sha256
  );
}

export async function absoluteEntryMatches(
  absolute: string,
  entry: WorkerWorkspaceManifestEntry,
): Promise<boolean> {
  const stats = await fs.lstat(absolute).catch(() => undefined);
  if (!stats) {
    return false;
  }
  if (entry.type === "symlink") {
    return stats.isSymbolicLink() && (await fs.readlink(absolute)) === entry.target;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return false;
  }
  return await fileEntryMatches(absolute, entry);
}

export async function entryMatches(
  root: string,
  entry: WorkerWorkspaceManifestEntry,
): Promise<boolean> {
  if (entry.type === "symlink") {
    return await absoluteEntryMatches(localPath(root, entry.path), entry);
  }
  return await fileEntryMatches(localPath(root, entry.path), entry, root);
}

export async function readWorkspaceTreeFile(params: {
  repositoryRoot: string;
  tree: string;
  entry: Extract<WorkerWorkspaceManifestEntry, { type: "file" }>;
}): Promise<Uint8Array> {
  const listed = await runGitBuffered(
    params.repositoryRoot,
    ["--literal-pathspecs", "ls-tree", "-z", "--full-tree", params.tree, "--", params.entry.path],
    {
      timeoutMs: PATCH_TIMEOUT_MS,
      maxOutputBytes: 1024 * 1024,
    },
  );
  if (listed.termination !== "exit" || listed.code !== 0) {
    throw new Error(listed.stderr.toString("utf8").trim() || "git ls-tree failed");
  }
  const record = listed.stdout;
  const terminator = record.indexOf(0);
  const separator = record.indexOf(9);
  if (terminator !== record.byteLength - 1 || separator < 0 || separator > terminator) {
    throw new Error(`Cloud workspace recovery snapshot is missing: ${params.entry.path}`);
  }
  const metadata = record.subarray(0, separator).toString("utf8");
  const match = /^100(?:644|755) blob ([a-f0-9]{40})$/u.exec(metadata);
  const listedPath = record.subarray(separator + 1, terminator);
  if (!match || !listedPath.equals(Buffer.from(params.entry.path))) {
    throw new Error(`Cloud workspace recovery snapshot is invalid: ${params.entry.path}`);
  }
  const blob = await runGitBuffered(params.repositoryRoot, ["cat-file", "blob", match[1]!], {
    timeoutMs: PATCH_TIMEOUT_MS,
    maxOutputBytes: MAX_RECONCILIATION_FILE_BYTES + 1,
  });
  if (blob.termination !== "exit" || blob.code !== 0) {
    throw new Error(blob.stderr.toString("utf8").trim() || "git cat-file failed");
  }
  if (
    blob.stdout.byteLength !== params.entry.size ||
    createHash("sha256").update(blob.stdout).digest("hex") !== params.entry.sha256
  ) {
    throw new Error(`Cloud workspace recovery snapshot is invalid: ${params.entry.path}`);
  }
  return blob.stdout;
}

export async function directoryContainsOnlyJournalPaths(
  root: string,
  directory: string,
  paths: ReadonlySet<string>,
  directories: ReadonlySet<string>,
  isRetainedInput: ReturnType<typeof createStagedInputPathMatcher>,
): Promise<boolean> {
  for (const name of await fs.readdir(localPath(root, directory))) {
    const child = `${directory}/${name}`;
    if (isManagedSandboxSkillsPath(child)) {
      return false;
    }
    if (isDerivedWorkspacePath(child, await isRetainedInput(child))) {
      continue;
    }
    const stats = await fs.lstat(localPath(root, child));
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      if (
        !directories.has(child) &&
        !(await directoryContainsOnlyDerivedWorkspaceEntries(root, child, isRetainedInput))
      ) {
        return false;
      }
      if (
        directories.has(child) &&
        !(await directoryContainsOnlyJournalPaths(root, child, paths, directories, isRetainedInput))
      ) {
        return false;
      }
    } else if (!paths.has(child)) {
      return false;
    }
  }
  return true;
}

export async function directoryContainsOnlyDerivedWorkspaceEntries(
  root: string,
  directory: string,
  isRetainedInput: ReturnType<typeof createStagedInputPathMatcher>,
): Promise<boolean> {
  const names = await fs.readdir(localPath(root, directory));
  let foundDerivedEntry = false;
  for (const name of names) {
    const child = `${directory}/${name}`;
    if (isManagedSandboxSkillsPath(child)) {
      return false;
    }
    if (isDerivedWorkspacePath(child, await isRetainedInput(child))) {
      foundDerivedEntry = true;
      continue;
    }
    const stats = await fs.lstat(localPath(root, child));
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      !(await directoryContainsOnlyDerivedWorkspaceEntries(root, child, isRetainedInput))
    ) {
      return false;
    }
    foundDerivedEntry = true;
  }
  return foundDerivedEntry;
}
