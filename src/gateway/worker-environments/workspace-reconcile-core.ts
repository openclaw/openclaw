import fs from "node:fs/promises";
import { FsSafeError, root as openFsSafeRoot } from "../../infra/fs-safe.js";
import { stagedInputDirectoriesFromEntries } from "../../media/staged-inputs.js";
import { activeWorkspaceHashContext, withWorkspaceHashMemo } from "./workspace-hash-memo.js";
import {
  hasPathAncestor,
  manifestNodes,
  prepareWorkspaceReconciliation,
  sameEntry,
} from "./workspace-manifest-comparison.js";
import {
  captureWorkspaceManifest,
  preflightWorkspaceApply,
  readWorkspaceNodes,
} from "./workspace-manifest-worker.js";
import type {
  WorkerWorkspaceManifest,
  WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import { workspacePathAncestors } from "./workspace-path-ancestors.js";
import { reconciliationDirectories } from "./workspace-reconcile-derived-paths.js";
import { removeEmptyWorkspaceDirectory } from "./workspace-reconcile-fs.js";
export { preflightWorkspaceApply } from "./workspace-manifest-worker.js";
export { changedPaths, manifestNodes } from "./workspace-manifest-comparison.js";
export { localWorkspaceNode } from "./workspace-reconcile-fs.js";
export {
  MAX_RECONCILIATION_FILE_BYTES,
  MAX_RECONCILIATION_TOTAL_BYTES,
  parseWorkerWorkspaceReconciliationPlan,
  serializeWorkerWorkspaceReconciliationPlan,
  type WorkerWorkspaceReconciliationJournal,
  type WorkerWorkspaceReconciliationJournalAdapter,
} from "./workspace-manifest.js";

export class ConcurrentWorkspacePathError extends Error {}

export type WorkerWorkspaceApplyResult = {
  manifestRef: string;
  manifest: WorkerWorkspaceManifest;
  conflictPaths: string[];
  verifyLocalStable(): Promise<void>;
};

export async function assertWorkspaceMatchesManifest(params: {
  root: string;
  manifest: WorkerWorkspaceManifest;
  entries?: readonly WorkerWorkspaceManifestEntry[];
}): Promise<void> {
  const root = await fs.realpath(params.root);
  const expectedNodes = params.entries ?? [...manifestNodes(params.manifest).values()];
  const actual = await readWorkspaceNodes(
    root,
    expectedNodes.map((entry) => entry.path),
  );
  for (const entry of expectedNodes) {
    if (!sameEntry(actual.get(entry.path), entry)) {
      throw new ConcurrentWorkspacePathError(
        `Gateway workspace changed after cloud dispatch: ${entry.path}`,
      );
    }
  }
}

export async function inspectAcceptedWorkerWorkspace(params: {
  root: string;
  expectedManifestRef: string;
  allowAdvancedLocalState?: boolean;
  base: WorkerWorkspaceManifest;
  current: WorkerWorkspaceManifest;
  additionalPaths?: ReadonlySet<string>;
}): Promise<WorkerWorkspaceApplyResult | undefined> {
  const root = await fs.realpath(params.root);
  const preserveDirectories = new Set(
    reconciliationDirectories(
      params.current.directories,
      stagedInputDirectoriesFromEntries(params.current.entries),
      params.current.buildCacheInputs,
    ),
  );
  const includePaths = params.current.baseCommit
    ? new Set([...manifestNodes(params.base).keys(), ...manifestNodes(params.current).keys()])
    : undefined;
  params.additionalPaths?.forEach((entryPath) => includePaths?.add(entryPath));
  const buildCacheInputs =
    params.base.buildCacheInputs === undefined && params.current.buildCacheInputs === undefined
      ? undefined
      : new Set([
          ...(params.base.buildCacheInputs ?? []),
          ...(params.current.buildCacheInputs ?? []),
        ]);
  const actual = await captureWorkspaceManifest({
    root,
    baseCommit: params.current.baseCommit,
    preserveDirectories,
    includePaths,
    buildCacheInputs,
  });
  if (actual.manifestRef !== params.expectedManifestRef && !params.allowAdvancedLocalState) {
    return undefined;
  }
  const preflight = await preflightWorkspaceApply({
    root,
    ...prepareWorkspaceReconciliation(params.base, params.current).preflight,
  });
  const conflictPaths = params.allowAdvancedLocalState
    ? retainedConflictPaths(preflight)
    : preflight.conflictPaths;
  return {
    ...actual,
    conflictPaths,
    verifyLocalStable: createWorkspaceManifestVerifier({
      root,
      expectedRef: actual.manifestRef,
      baseCommit: actual.manifest.baseCommit,
      preserveDirectories,
      includePaths,
      buildCacheInputs,
    }),
  };
}

export async function assertActualWorkspaceManifest(params: {
  root: string;
  expectedRef: string;
  baseCommit: string | null;
  preserveDirectories?: ReadonlySet<string>;
  includePaths?: ReadonlySet<string>;
  buildCacheInputs?: ReadonlySet<string>;
}): Promise<void> {
  const actual = await captureWorkspaceManifest(params);
  if (actual.manifestRef !== params.expectedRef) {
    throw new ConcurrentWorkspacePathError("Gateway workspace changed after cloud reconciliation");
  }
}

export function createWorkspaceManifestVerifier(
  params: Parameters<typeof assertActualWorkspaceManifest>[0],
): () => Promise<void> {
  const { memo, metrics } = activeWorkspaceHashContext() ?? {};
  const verify = () => assertActualWorkspaceManifest(params);
  return () => (memo ? withWorkspaceHashMemo(memo, verify, metrics) : verify());
}

export async function applyWorkspaceDirectoryChanges(params: {
  root: string;
  baseNodes: ReturnType<typeof manifestNodes>;
  currentNodes: ReturnType<typeof manifestNodes>;
  applyPaths: ReadonlySet<string>;
  assertCurrent?: () => void;
}): Promise<void> {
  const workspaceRoot = await openFsSafeRoot(params.root, {
    mode: 0o700,
    assertBeforeMutation: params.assertCurrent,
  });
  const { baseNodes, currentNodes } = params;
  const directoryPaths = [...params.applyPaths].filter(
    (entryPath) =>
      baseNodes.get(entryPath)?.type === "directory" ||
      currentNodes.get(entryPath)?.type === "directory",
  );
  const retainedDirectories = new Set(directoryPaths);
  // Git prunes empty ancestors when deleting their last leaf. Recreate only
  // ancestors of admitted changes that the worker still retains as directories.
  for (const entryPath of params.applyPaths) {
    for (const ancestor of workspacePathAncestors(entryPath)) {
      if (currentNodes.get(ancestor)?.type === "directory") {
        retainedDirectories.add(ancestor);
      }
    }
  }
  for (const entryPath of [...retainedDirectories].toSorted()) {
    const currentDirectory = currentNodes.get(entryPath);
    if (currentDirectory?.type === "directory") {
      await workspaceRoot.mkdir(entryPath);
    }
  }
  const removedDirectoryPaths = directoryPaths.filter(
    (entryPath) => baseNodes.get(entryPath)?.type === "directory" && !currentNodes.has(entryPath),
  );
  for (const entryPath of removedDirectoryPaths.toSorted((left, right) =>
    right.localeCompare(left),
  )) {
    let directoryState;
    try {
      directoryState = await workspaceRoot.stat(entryPath);
    } catch (error) {
      if (error instanceof FsSafeError && ["not-found", "path-alias"].includes(error.code)) {
        continue;
      }
      throw error;
    }
    if (!directoryState.isDirectory) {
      // A concurrent local replacement wins and becomes a conflict.
      continue;
    }
    await removeEmptyWorkspaceDirectory(workspaceRoot, entryPath);
  }
}

export function retainedConflictPaths(
  preflight: {
    applyPaths: ReadonlySet<string>;
    conflictPaths: readonly string[];
    blockingConflictPaths: readonly string[];
  },
  originalApplyPaths?: ReadonlySet<string>,
): string[] {
  const retainedApplyPaths = [...preflight.applyPaths].filter(
    (entryPath) =>
      !originalApplyPaths?.has(entryPath) ||
      !preflight.conflictPaths.some((conflictPath) => conflictPath.startsWith(`${entryPath}/`)),
  );
  const conflicts = new Set([...preflight.conflictPaths, ...retainedApplyPaths]);
  const blockingConflicts = new Set(preflight.blockingConflictPaths);
  return [...conflicts]
    .filter((entryPath) => !hasPathAncestor(blockingConflicts, entryPath))
    .toSorted();
}
