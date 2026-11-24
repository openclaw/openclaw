import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError, root as openFsSafeRoot, type Root } from "../../infra/fs-safe.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import {
  createStagedInputPathMatcher,
  isStagedInputPath,
  stagedInputDirectoriesFromEntries,
} from "../../media/staged-inputs.js";
import type { WorkerWorkspaceManifestEntry } from "./workspace-manifest.js";
import { workspacePathAncestors } from "./workspace-path-ancestors.js";
import {
  isDerivedWorkspacePath,
  isRuntimeOwnedWorkspacePath,
  buildCacheInputPaths,
} from "./workspace-path-exclusions.js";

export function reconciliationEntries(
  entries: readonly WorkerWorkspaceManifestEntry[],
  stagedInputDirectories: ReadonlySet<string> = stagedInputDirectoriesFromEntries(entries),
  buildCacheInputs?: string[],
): WorkerWorkspaceManifestEntry[] {
  const retained = buildCacheInputPaths(buildCacheInputs);
  return entries.filter(
    (entry) =>
      !isDerivedWorkspacePath(
        entry.path,
        retained.has(entry.path) || isStagedInputPath(entry.path, stagedInputDirectories),
        buildCacheInputs !== undefined,
      ),
  );
}

export function reconciliationDirectories(
  directories: readonly string[] | undefined,
  stagedInputDirectories: ReadonlySet<string>,
  buildCacheInputs?: string[],
): string[] {
  const retained = buildCacheInputPaths(buildCacheInputs);
  return (directories ?? []).filter(
    (directory) =>
      !isDerivedWorkspacePath(
        directory,
        retained.has(directory) || isStagedInputPath(directory, stagedInputDirectories),
        buildCacheInputs !== undefined,
      ),
  );
}

async function removeDerivedWorkspaceDescendants(
  root: Root,
  relativeDirectory: string,
  isRetainedInput: ReturnType<typeof createStagedInputPathMatcher>,
  excludeBuildCaches: boolean,
): Promise<void> {
  for (const entry of await root.list(relativeDirectory, { withFileTypes: true })) {
    const child = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (isRuntimeOwnedWorkspacePath(child)) {
      continue;
    }
    if (isDerivedWorkspacePath(child, await isRetainedInput(child), excludeBuildCaches)) {
      await removeDerivedWorkspaceEntry(root, child, entry.isDirectory);
      continue;
    }
    if (entry.isDirectory) {
      await removeDerivedWorkspaceDescendants(root, child, isRetainedInput, excludeBuildCaches);
      if ((await root.list(child)).length === 0) {
        // This traversal only runs beneath a manifest non-directory replacing
        // relativeDirectory. Every empty descendant belongs to that old namespace,
        // and pruning it unconditionally keeps interrupted cleanup resumable.
        await root.remove(child);
      }
    }
  }
}

async function removeDerivedWorkspaceEntry(
  root: Root,
  relativePath: string,
  isDirectory: boolean,
): Promise<void> {
  if (isDirectory) {
    let entries;
    try {
      entries = await root.list(relativePath, { withFileTypes: true });
    } catch (error) {
      if (!(error instanceof FsSafeError) || !["not-found", "path-alias"].includes(error.code)) {
        throw error;
      }
      entries = undefined;
    }
    for (const entry of entries ?? []) {
      await removeDerivedWorkspaceEntry(root, `${relativePath}/${entry.name}`, entry.isDirectory);
    }
  }
  await root.remove(relativePath).catch((error: unknown) => {
    if (!(error instanceof FsSafeError) || error.code !== "not-found") {
      throw error;
    }
  });
}

async function hasWorkspaceSymlinkAncestor(root: string, relativePath: string): Promise<boolean> {
  for (const ancestor of workspacePathAncestors(relativePath)) {
    const stats = await fs.lstat(path.join(root, ancestor)).catch(() => undefined);
    if (stats?.isSymbolicLink()) {
      return true;
    }
  }
  return false;
}

export async function prepareNonDirectoryTargets(
  root: string,
  entries: readonly WorkerWorkspaceManifestEntry[],
  retainedInput?: ReturnType<typeof createStagedInputPathMatcher>,
  assertCurrent?: () => void,
  excludeBuildCaches = false,
): Promise<void> {
  const workspaceRoot = await openFsSafeRoot(root, { assertBeforeMutation: assertCurrent });
  const isRetainedInput = retainedInput ?? createStagedInputPathMatcher(workspaceRoot);
  // Entries are an already-selected delta; an unchanged ownership marker may be absent.
  for (const entry of entries) {
    const stats = await fs.lstat(path.join(root, entry.path)).catch(async (error: unknown) => {
      if (
        hasNodeErrorCode(error, "ENOENT") ||
        hasNodeErrorCode(error, "ENOTDIR") ||
        (await hasWorkspaceSymlinkAncestor(root, entry.path))
      ) {
        return undefined;
      }
      throw error;
    });
    if (stats?.isDirectory() && !(await hasWorkspaceSymlinkAncestor(root, entry.path))) {
      // Excluded descendants cannot fence a namespace replacement, but Git
      // cannot replace their still-nonempty parent until they are removed.
      // fs-safe binds traversal/removal to root-relative directory handles, so
      // a symlink swap cannot redirect cleanup outside this workspace.
      await removeDerivedWorkspaceDescendants(
        workspaceRoot,
        entry.path,
        isRetainedInput,
        excludeBuildCaches,
      );
      if ((await workspaceRoot.list(entry.path)).length === 0) {
        await workspaceRoot.remove(entry.path);
      }
    }
  }
}
