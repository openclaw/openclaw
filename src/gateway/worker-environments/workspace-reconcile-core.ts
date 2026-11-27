import fs from "node:fs/promises";
import { FsSafeError, root as openFsSafeRoot } from "../../infra/fs-safe.js";
import {
  createStagedInputPathMatcher,
  stagedInputDirectoriesFromEntries,
} from "../../media/staged-inputs.js";
import { activeWorkspaceHashContext, withWorkspaceHashMemo } from "./workspace-hash-memo.js";
import {
  hasPathAncestor,
  manifestNodes,
  sameEntry,
  type WorkspaceReconciliationPreparation,
} from "./workspace-manifest-comparison.js";
import {
  captureWorkspaceManifest,
  captureWorkspaceManifestReference,
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
      throw new Error(`Gateway workspace changed after cloud dispatch: ${entry.path}`);
    }
  }
}

export async function inspectAcceptedWorkerWorkspace(params: {
  root: string;
  expectedManifestRef: string;
  allowAdvancedLocalState?: boolean;
  reconciliation: WorkspaceReconciliationPreparation;
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
  const { preflight: preflightInput, includePaths: preparedPaths } = params.reconciliation;
  const includePaths =
    preparedPaths && params.additionalPaths?.size
      ? new Set([...preparedPaths, ...params.additionalPaths])
      : preparedPaths;
  const buildCacheInputs =
    preflightInput.buildCacheInputs === undefined
      ? undefined
      : new Set(preflightInput.buildCacheInputs);
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
    ...preflightInput,
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
  const actual = await captureWorkspaceManifestReference(params);
  if (actual !== params.expectedRef) {
    throw new Error("Gateway workspace changed after cloud reconciliation");
  }
}

export function createWorkspaceManifestVerifier(
  params: Parameters<typeof assertActualWorkspaceManifest>[0],
): () => Promise<void> {
  const { memo, metrics } = activeWorkspaceHashContext() ?? {};
  const verify = () => assertActualWorkspaceManifest(params);
  return () => (memo ? withWorkspaceHashMemo(memo, verify, metrics) : verify());
}

export function prepareWorkspaceDirectoryChanges(params: {
  baseNodes: ReturnType<typeof manifestNodes>;
  currentNodes: ReturnType<typeof manifestNodes>;
  applyPaths: ReadonlySet<string>;
}) {
  const { baseNodes, currentNodes } = params;
  const directoryPaths = [...params.applyPaths].filter(
    (entryPath) =>
      baseNodes.get(entryPath)?.type === "directory" ||
      currentNodes.get(entryPath)?.type === "directory",
  );
  const retained = new Set(directoryPaths);
  // Git prunes empty ancestors when deleting their last leaf. Preserve only
  // directories that the already-admitted current manifest still owns.
  for (const entryPath of params.applyPaths) {
    for (const ancestor of workspacePathAncestors(entryPath)) {
      if (currentNodes.get(ancestor)?.type === "directory") {
        retained.add(ancestor);
      }
    }
  }
  return {
    retained: [...retained]
      .filter((entryPath) => currentNodes.get(entryPath)?.type === "directory")
      .toSorted(),
    removed: directoryPaths
      .filter(
        (entryPath) =>
          baseNodes.get(entryPath)?.type === "directory" && !currentNodes.has(entryPath),
      )
      .toSorted((left, right) => right.localeCompare(left)),
  };
}

export async function applyWorkspaceDirectoryChanges(params: {
  root: string;
  directories: ReturnType<typeof prepareWorkspaceDirectoryChanges>;
  assertCurrent?: () => void;
}): Promise<void> {
  const workspaceRoot = await openFsSafeRoot(params.root, {
    mode: 0o700,
    assertBeforeMutation: params.assertCurrent,
  });
  for (const entryPath of params.directories.retained) {
    await workspaceRoot.mkdir(entryPath);
  }
  for (const entryPath of params.directories.removed) {
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
  // Build ancestor membership once: a large conflict set must not cause a
  // synchronous apply-path × conflict-path scan on the Gateway thread.
  const conflictAncestors = new Set<string>();
  for (const conflictPath of preflight.conflictPaths) {
    for (const ancestor of workspacePathAncestors(conflictPath)) {
      conflictAncestors.add(ancestor);
    }
  }
  const retainedApplyPaths = [...preflight.applyPaths].filter(
    (entryPath) => !originalApplyPaths?.has(entryPath) || !conflictAncestors.has(entryPath),
  );
  const conflicts = new Set([...preflight.conflictPaths, ...retainedApplyPaths]);
  const blockingConflicts = new Set(preflight.blockingConflictPaths);
  return [...conflicts]
    .filter((entryPath) => !hasPathAncestor(blockingConflicts, entryPath))
    .toSorted();
}

export async function assertWorkspaceInputOwnership({
  root,
  stagedInputDirectories,
  candidates,
}: import("./workspace-manifest-computation.js").WorkspaceReconciliationOperations["workspace.reconcile.ownership"]["input"]): Promise<void> {
  const workspaceRoot = await openFsSafeRoot(root);
  const isRetainedInput = createStagedInputPathMatcher(workspaceRoot);
  const unownedInputDirectories = new Set<string>();
  for (const directory of stagedInputDirectories) {
    if ((await workspaceRoot.exists(directory)) && !(await isRetainedInput(directory))) {
      unownedInputDirectories.add(directory);
    }
  }
  // Producer markers cannot enroll local project data or overwrite its ownership.
  for (const { path: entryPath, directory, changesMarker, isNew } of candidates) {
    if (!unownedInputDirectories.has(directory)) {
      continue;
    }
    if (changesMarker || (isNew && (await workspaceRoot.exists(entryPath)))) {
      throw new Error(
        `Cloud input conflicts with an unowned Gateway directory: ${directory}. Keep the project directory unchanged and reattach the input.`,
      );
    }
  }
}
