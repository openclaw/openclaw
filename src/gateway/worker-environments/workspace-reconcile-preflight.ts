import fs from "node:fs/promises";
import { root as openFsSafeRoot } from "../../infra/fs-safe.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import { createStagedInputPathMatcher } from "../../media/staged-inputs.js";
import { isManagedSandboxSkillsPath } from "../../shared/sandbox-workspace-paths.js";
import { MAX_WORKSPACE_INVENTORY_ENTRIES } from "./workspace-inventory-limits.js";
import {
  hasPathAncestor,
  manifestNodes,
  sameEntry,
  type WorkspaceNode,
} from "./workspace-manifest-comparison.js";
import type { WorkerWorkspaceManifest } from "./workspace-manifest.js";
import { isDerivedWorkspacePath } from "./workspace-path-exclusions.js";
import {
  directoryContainsOnlyDerivedWorkspaceEntries,
  localPath,
  localWorkspaceNode,
} from "./workspace-reconcile-fs.js";

const MAX_RECONCILIATION_PATH_BYTES = 64 * 1024 * 1024;

async function localWorkspaceDescendantPaths(
  root: string,
  entryPaths: readonly string[],
  isRetainedInput: ReturnType<typeof createStagedInputPathMatcher>,
  nonDirectoryReplacements: ReadonlySet<string>,
): Promise<string[]> {
  const paths: string[] = [];
  const pending = [...entryPaths];
  let pathBytes = 0;
  let enumeratedEntries = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const names: string[] = [];
    for await (const entry of await fs.opendir(localPath(root, directory))) {
      names.push(entry.name);
      enumeratedEntries += 1;
      if (enumeratedEntries > MAX_WORKSPACE_INVENTORY_ENTRIES) {
        throw new Error("Gateway workspace manifest has too many entries");
      }
    }
    for (const name of names.toSorted()) {
      const childPath = `${directory}/${name}`;
      pathBytes += Buffer.byteLength(childPath);
      if (pathBytes > MAX_RECONCILIATION_PATH_BYTES) {
        throw new Error("Gateway workspace manifest paths exceed their byte limit");
      }
      if (isManagedSandboxSkillsPath(childPath)) {
        // Runtime projections are excluded edits, not disposable cache children.
        // Surface their presence as a conflict before replacing an ancestor.
        if (hasPathAncestor(nonDirectoryReplacements, childPath)) {
          paths.push(childPath);
        }
        continue;
      }
      if (isDerivedWorkspacePath(childPath, await isRetainedInput(childPath))) {
        continue;
      }
      paths.push(childPath);
      const stats = await fs.lstat(localPath(root, childPath));
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        pending.push(childPath);
      }
    }
  }
  return paths;
}

export async function preflightWorkspaceApplyImpl(params: {
  root: string;
  base: WorkerWorkspaceManifest;
  current: WorkerWorkspaceManifest;
}): Promise<{
  applyPaths: Set<string>;
  conflictPaths: string[];
  blockingConflictPaths: string[];
}> {
  const isRetainedInput = createStagedInputPathMatcher(await openFsSafeRoot(params.root));
  const baseNodes = manifestNodes(params.base);
  const currentNodes = manifestNodes(params.current);
  const manifestPaths = [...new Set([...baseNodes.keys(), ...currentNodes.keys()])];
  const changed = new Set(
    manifestPaths.filter(
      (entryPath) => !sameEntry(baseNodes.get(entryPath), currentNodes.get(entryPath)),
    ),
  );
  const structurallyReplacedDirectories = new Set(
    [...changed].filter(
      (entryPath) =>
        baseNodes.get(entryPath)?.type === "directory" &&
        currentNodes.get(entryPath)?.type !== "directory",
    ),
  );
  const structuralRoots = [...structurallyReplacedDirectories].filter(
    (entryPath) => !hasPathAncestor(structurallyReplacedDirectories, entryPath),
  );
  const localStructuralRoots: string[] = [];
  for (const entryPath of structuralRoots) {
    const stats = await fs.lstat(localPath(params.root, entryPath)).catch(() => undefined);
    if (stats?.isDirectory() && !stats.isSymbolicLink()) {
      localStructuralRoots.push(entryPath);
    }
  }
  // Traverse disjoint replacement roots once with one shared budget. A manifest
  // lists every nested directory, so walking from each changed path is quadratic.
  const localStructuralPaths = await localWorkspaceDescendantPaths(
    params.root,
    localStructuralRoots,
    isRetainedInput,
    new Set(structuralRoots.filter((entryPath) => currentNodes.has(entryPath))),
  );
  const paths = [...new Set([...changed, ...localStructuralPaths])].toSorted();
  const applyPaths = new Set<string>();
  const conflicts = new Set<string>();
  const blockingConflicts = new Set<string>();
  // Node snapshots may be shared only inside this pass. Separate preflight
  // calls are concurrency fences and must stat paths again.
  const localNodes = new Map<string, Promise<WorkspaceNode>>();
  const localNode = (entryPath: string): Promise<WorkspaceNode> => {
    const existing = localNodes.get(entryPath);
    if (existing) {
      return existing;
    }
    const node = localWorkspaceNode(params.root, entryPath);
    localNodes.set(entryPath, node);
    return node;
  };
  for (const entryPath of paths) {
    if (hasPathAncestor(blockingConflicts, entryPath)) {
      continue;
    }
    const currentNode = currentNodes.get(entryPath);
    const deletionAlreadySatisfied =
      currentNode === undefined &&
      !(await fs.lstat(localPath(params.root, entryPath)).catch((error: unknown) => {
        if (hasNodeErrorCode(error, "ENOENT") || hasNodeErrorCode(error, "ENOTDIR")) {
          return undefined;
        }
        throw error;
      }));
    if (deletionAlreadySatisfied) {
      // A deletion can already be satisfied because local also removed an
      // unchanged ancestor. Do not turn that convergence into a conflict.
      continue;
    }
    const segments = entryPath.split("/");
    let localAncestorConflict = false;
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join("/");
      const baseAncestor = baseNodes.get(ancestor);
      const currentAncestor = currentNodes.get(ancestor);
      if (!baseAncestor && !currentAncestor) {
        const localAncestor = await localNode(ancestor);
        if (localAncestor && localAncestor.type !== "directory") {
          conflicts.add(ancestor);
          blockingConflicts.add(ancestor);
          localAncestorConflict = true;
          break;
        }
        continue;
      }
      const localAncestor = await localNode(ancestor);
      if (!sameEntry(localAncestor, baseAncestor) && !sameEntry(localAncestor, currentAncestor)) {
        conflicts.add(ancestor);
        blockingConflicts.add(ancestor);
        localAncestorConflict = true;
        break;
      }
    }
    if (localAncestorConflict) {
      continue;
    }
    let local: WorkspaceNode;
    let replacedBaseAncestor = false;
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join("/");
      const baseAncestor = baseNodes.get(ancestor);
      if (
        baseAncestor &&
        baseAncestor.type !== "directory" &&
        !sameEntry(baseAncestor, currentNodes.get(ancestor)) &&
        sameEntry(await localNode(ancestor), baseAncestor)
      ) {
        replacedBaseAncestor = true;
        break;
      }
    }
    if (replacedBaseAncestor) {
      local = undefined;
    } else {
      local = await localNode(entryPath);
      if (
        local?.type === "directory" &&
        (!baseNodes.has(entryPath) || !currentNodes.has(entryPath)) &&
        currentNodes.get(entryPath)?.type !== "directory" &&
        (await directoryContainsOnlyDerivedWorkspaceEntries(
          params.root,
          entryPath,
          isRetainedInput,
        ))
      ) {
        local = undefined;
      }
    }
    if (sameEntry(local, baseNodes.get(entryPath))) {
      if (changed.has(entryPath)) {
        applyPaths.add(entryPath);
      }
    } else if (!sameEntry(local, currentNodes.get(entryPath))) {
      conflicts.add(entryPath);
      const current = currentNodes.get(entryPath);
      if (
        (current?.type === "directory" && local !== undefined && local.type !== "directory") ||
        (current !== undefined && current.type !== "directory" && local?.type === "directory")
      ) {
        blockingConflicts.add(entryPath);
      }
    }
  }
  // Replacing a directory with a file/symlink would erase every descendant in
  // one filesystem operation. Lift a descendant conflict to that replacement.
  const initialConflictPaths = Array.from(conflicts);
  for (const conflictPath of initialConflictPaths) {
    const segments = conflictPath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join("/");
      const workerNode = currentNodes.get(ancestor);
      if (changed.has(ancestor) && workerNode && workerNode.type !== "directory") {
        conflicts.add(ancestor);
        blockingConflicts.add(ancestor);
        break;
      }
    }
  }
  const conflictPaths = [...conflicts]
    .filter((entryPath) => !hasPathAncestor(blockingConflicts, entryPath))
    .toSorted();
  const blockingConflictPaths = [...blockingConflicts]
    .filter((entryPath) => !hasPathAncestor(blockingConflicts, entryPath))
    .toSorted();
  const conflictPathSet = new Set(conflictPaths);
  const blockingConflictPathSet = new Set(blockingConflictPaths);
  for (const entryPath of applyPaths) {
    if (conflictPathSet.has(entryPath) || hasPathAncestor(blockingConflictPathSet, entryPath)) {
      applyPaths.delete(entryPath);
    }
  }
  return { applyPaths, conflictPaths, blockingConflictPaths };
}
