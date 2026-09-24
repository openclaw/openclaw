import { isStagedInputPath, stagedInputDirectoriesFromEntries } from "../../media/staged-inputs.js";
import {
  MAX_RECONCILIATION_ENTRIES,
  MAX_RECONCILIATION_FILE_BYTES,
  MAX_RECONCILIATION_TOTAL_BYTES,
  type WorkerWorkspaceManifest,
  type WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import { isDerivedWorkspacePath } from "./workspace-path-exclusions.js";

export type WorkspaceNode =
  | WorkerWorkspaceManifestEntry
  | { path: string; type: "directory" }
  | { path: string; type: "unsupported" }
  | undefined;

export function sameEntry(left: WorkspaceNode, right: WorkspaceNode): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.path !== right.path || left.type !== right.type) {
    return false;
  }
  switch (left.type) {
    case "file":
      return (
        right.type === "file" &&
        left.mode === right.mode &&
        left.size === right.size &&
        left.sha256 === right.sha256
      );
    case "symlink":
      return right.type === "symlink" && left.mode === right.mode && left.target === right.target;
    default:
      return true;
  }
}

export function manifestNodes(manifest: WorkerWorkspaceManifest): Map<string, WorkspaceNode> {
  const staged = stagedInputDirectoriesFromEntries(manifest.entries);
  const nodes = new Map<string, WorkspaceNode>();
  for (const directory of manifest.directories ?? []) {
    if (!isDerivedWorkspacePath(directory, isStagedInputPath(directory, staged))) {
      nodes.set(directory, { path: directory, type: "directory" });
    }
  }
  for (const entry of manifest.entries) {
    if (!isDerivedWorkspacePath(entry.path, isStagedInputPath(entry.path, staged))) {
      nodes.set(entry.path, entry);
    }
  }
  return nodes;
}

export function hasPathAncestor(paths: ReadonlySet<string>, entryPath: string): boolean {
  const segments = entryPath.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    if (paths.has(segments.slice(0, index).join("/"))) {
      return true;
    }
  }
  return false;
}

export function changedPaths(
  base: WorkerWorkspaceManifest,
  current: WorkerWorkspaceManifest,
  signal?: AbortSignal,
): Set<string> {
  signal?.throwIfAborted();
  const baseNodes = manifestNodes(base);
  const currentNodes = manifestNodes(current);
  const changed = new Set<string>();
  // Preserve base order followed by newly introduced current paths.
  for (const [entryPath, entry] of baseNodes) {
    if (!sameEntry(entry, currentNodes.get(entryPath))) {
      changed.add(entryPath);
    }
  }
  for (const entryPath of currentNodes.keys()) {
    if (!baseNodes.has(entryPath)) {
      changed.add(entryPath);
    }
  }
  return changed;
}

export function parseChangedWorkspaceResult(
  base: WorkerWorkspaceManifest,
  current: WorkerWorkspaceManifest,
  enforceRecordLimit = true,
): { changed: boolean; entries: WorkerWorkspaceManifestEntry[] } {
  const remainingBase = manifestNodes(base);
  const staged = stagedInputDirectoriesFromEntries(current.entries);
  let recordCount = 0;
  for (const directory of current.directories ?? []) {
    if (isDerivedWorkspacePath(directory, isStagedInputPath(directory, staged))) {
      continue;
    }
    const previous = remainingBase.get(directory);
    if (previous?.type !== "directory") {
      recordCount += previous ? 2 : 1;
    }
    remainingBase.delete(directory);
  }
  const entries: WorkerWorkspaceManifestEntry[] = [];
  for (const entry of current.entries) {
    if (isDerivedWorkspacePath(entry.path, isStagedInputPath(entry.path, staged))) {
      continue;
    }
    const previous = remainingBase.get(entry.path);
    if (!sameEntry(previous, entry)) {
      recordCount += previous ? 2 : 1;
      entries.push(entry);
    }
    remainingBase.delete(entry.path);
  }
  recordCount += remainingBase.size;
  if (enforceRecordLimit && recordCount > MAX_RECONCILIATION_ENTRIES) {
    throw new Error(
      `Cloud workspace reconciliation exceeds the ${MAX_RECONCILIATION_ENTRIES} entry limit`,
    );
  }
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.type === "file" && entry.size > MAX_RECONCILIATION_FILE_BYTES) {
      throw new Error(`Cloud workspace result is too large: ${entry.path}`);
    }
    totalBytes += entry.type === "file" ? entry.size : Buffer.byteLength(entry.target);
    if (totalBytes > MAX_RECONCILIATION_TOTAL_BYTES) {
      throw new Error("Cloud workspace staged result exceeds its byte limit");
    }
  }
  return { changed: recordCount > 0, entries };
}
