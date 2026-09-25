import fs from "node:fs/promises";
import { FsSafeError, root as openFsSafeRoot } from "../../infra/fs-safe.js";
import { stagedInputDirectoriesFromEntries } from "../../media/staged-inputs.js";
import { activeWorkspaceHashContext, withWorkspaceHashMemo } from "./workspace-hash-memo.js";
import {
  hasPathAncestor,
  manifestNodes,
  sameEntry,
  type WorkspaceNode,
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
  const expectedNodes = params.entries
    ? params.entries
    : [...manifestNodes(params.manifest).values()].filter(
        (entry): entry is Exclude<WorkspaceNode, undefined> => entry !== undefined,
      );
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

export async function readActualWorkspaceManifest(params: {
  root: string;
  baseCommit: string | null;
  preserveDirectories?: ReadonlySet<string>;
  includePaths?: ReadonlySet<string>;
  signal?: AbortSignal;
}): Promise<{ manifest: WorkerWorkspaceManifest; manifestRef: string }> {
  return await captureWorkspaceManifest(params);
}

export async function inspectAcceptedWorkerWorkspace(params: {
  root: string;
  expectedManifestRef: string;
  allowAdvancedLocalState?: boolean;
  base: WorkerWorkspaceManifest;
  current: WorkerWorkspaceManifest;
}): Promise<WorkerWorkspaceApplyResult | undefined> {
  const root = await fs.realpath(params.root);
  const { memo: hashMemo, metrics } = activeWorkspaceHashContext() ?? {};
  const preserveDirectories = new Set(
    reconciliationDirectories(
      params.current.directories,
      stagedInputDirectoriesFromEntries(params.current.entries),
    ),
  );
  const includePaths = params.current.baseCommit
    ? new Set([...manifestNodes(params.base).keys(), ...manifestNodes(params.current).keys()])
    : undefined;
  const actual = await readActualWorkspaceManifest({
    root,
    baseCommit: params.current.baseCommit,
    preserveDirectories,
    includePaths,
  });
  if (actual.manifestRef !== params.expectedManifestRef && !params.allowAdvancedLocalState) {
    return undefined;
  }
  const preflight = await preflightWorkspaceApply({
    root,
    base: params.base,
    current: params.current,
  });
  const conflictPaths = params.allowAdvancedLocalState
    ? retainedConflictPaths(preflight)
    : preflight.conflictPaths;
  const verifyLocalStable = async () =>
    await assertActualWorkspaceManifest({
      root,
      expectedRef: actual.manifestRef,
      baseCommit: actual.manifest.baseCommit,
      preserveDirectories,
      includePaths,
    });
  return {
    ...actual,
    conflictPaths,
    verifyLocalStable: async () =>
      hashMemo
        ? await withWorkspaceHashMemo(hashMemo, verifyLocalStable, metrics)
        : await verifyLocalStable(),
  };
}

export async function assertActualWorkspaceManifest(params: {
  root: string;
  expectedRef: string;
  baseCommit: string | null;
  preserveDirectories?: ReadonlySet<string>;
  includePaths?: ReadonlySet<string>;
}): Promise<void> {
  const actual = await readActualWorkspaceManifest(params);
  if (actual.manifestRef !== params.expectedRef) {
    throw new ConcurrentWorkspacePathError("Gateway workspace changed after cloud reconciliation");
  }
}

export async function applyWorkspaceDirectoryChanges(params: {
  root: string;
  base: WorkerWorkspaceManifest;
  current: WorkerWorkspaceManifest;
  applyPaths: ReadonlySet<string>;
  assertCurrent?: () => void;
}): Promise<void> {
  const workspaceRoot = await openFsSafeRoot(params.root, {
    mode: 0o700,
    assertBeforeMutation: params.assertCurrent,
  });
  const baseNodes = manifestNodes(params.base);
  const currentNodes = manifestNodes(params.current);
  const directoryPaths = [...params.applyPaths].filter(
    (entryPath) =>
      baseNodes.get(entryPath)?.type === "directory" ||
      currentNodes.get(entryPath)?.type === "directory",
  );
  for (const entryPath of directoryPaths.toSorted()) {
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
    const baseDirectory = baseNodes.get(entryPath);
    let directoryState;
    try {
      directoryState = await workspaceRoot.stat(entryPath);
    } catch (error) {
      if (error instanceof FsSafeError && ["not-found", "path-alias"].includes(error.code)) {
        continue;
      }
      throw error;
    }
    if (!directoryState.isDirectory || baseDirectory?.type !== "directory") {
      // A concurrent local replacement or chmod wins and becomes a conflict.
      continue;
    }
    await removeEmptyWorkspaceDirectory(workspaceRoot, entryPath);
  }
}

export function hasReplacedBaseEntryAncestor(
  entryPath: string,
  baseByPath: ReadonlyMap<string, WorkerWorkspaceManifestEntry>,
  currentByPath: ReadonlyMap<string, WorkerWorkspaceManifestEntry>,
): boolean {
  const segments = entryPath.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const ancestor = segments.slice(0, index).join("/");
    const baseEntry = baseByPath.get(ancestor);
    if (baseEntry && !sameEntry(baseEntry, currentByPath.get(ancestor))) {
      return true;
    }
  }
  return false;
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
