import fs from "node:fs/promises";
import path from "node:path";
import { readGitRefs } from "../../infra/git-root.js";
import { runBestEffortCleanup } from "../../infra/non-fatal-cleanup.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { WorkerLocalWorkspaceReconcileRequest } from "./tunnel-contract.js";
import { boundedWorkerError } from "./worker-error.js";
import {
  activeWorkspaceHashContext,
  withWorkspaceHashContext,
  withWorkspaceHashMemo,
} from "./workspace-hash-memo.js";
import { parseChangedWorkspaceResult } from "./workspace-manifest-comparison.js";
import type { WorkspaceStageInputSource } from "./workspace-manifest-computation.js";
import {
  prepareWorkspaceStageInput,
  computeWorkspaceManifest,
} from "./workspace-manifest-worker.js";
import type {
  WorkerWorkspaceManifest,
  WorkerWorkspaceReconciliationJournalAdapter,
} from "./workspace-manifest.js";
import {
  applyStagedWorkerWorkspace,
  inspectAcceptedWorkerWorkspace,
  type WorkerWorkspaceApplyResult,
} from "./workspace-reconcile.js";
import {
  requireWorkspaceResultGit as requireGit,
  updateWorkspaceResultRefs,
  withWorkspaceResultRefMutation,
} from "./workspace-result-git.js";
import { importWorkerWorkspaceHistory } from "./workspace-result-history.js";
import type {
  WorkerWorkspaceGitHistory,
  StagedWorkerWorkspaceInventory,
  StagedWorkerWorkspaceResult,
} from "./workspace-result-inventory.js";
import {
  requireWorkerResultStorageRef,
  WORKER_RESULT_CANDIDATE_REF_PREFIX,
  WORKER_RESULT_CLEANUP_REF_PREFIX,
  WORKER_RESULT_REF_PREFIX,
} from "./workspace-result-inventory.js";
import {
  resolveWorkspaceResultStorage,
  deleteEmptyWorkspaceResultStorage,
  type WorkspaceResultStorage,
} from "./workspace-result-storage.js";
export { adoptStagedWorkerWorkspaceHistory } from "./workspace-result-history.js";

const WORKER_RESULT_CLAIM_ID_PATTERN = /^[A-Za-z0-9-]+$/u;
const workspaceLog = createSubsystemLogger("gateway/worker-workspace");

export function workerWorkspaceTransferPaths(
  current: WorkerWorkspaceManifest,
  base: WorkerWorkspaceManifest,
  signal?: AbortSignal,
): string[] {
  // Recovery also transfers previously admitted bytes; new results are capped at staging.
  signal?.throwIfAborted();
  return parseChangedWorkspaceResult(base, current, false).entries.map((entry) => entry.path);
}

function requireWorkerResultRef(ref: string): string {
  if (!ref.startsWith(`${WORKER_RESULT_REF_PREFIX}/`)) {
    throw new Error("Cloud workspace staged result reference is invalid");
  }
  return requireWorkerResultStorageRef(ref);
}

export function workerWorkspaceResultRef(claimId: string): string {
  if (!WORKER_RESULT_CLAIM_ID_PATTERN.test(claimId)) {
    throw new Error("Cloud workspace result claim id is invalid");
  }
  return `${WORKER_RESULT_REF_PREFIX}/${claimId}`;
}

export function preparedWorkerWorkspaceResultRef(stagedResultRef: string): string {
  const ref = requireWorkerResultRef(stagedResultRef);
  return `${WORKER_RESULT_CANDIDATE_REF_PREFIX}/${ref.slice(WORKER_RESULT_REF_PREFIX.length + 1)}`;
}

export function cleanupWorkerWorkspaceResultRef(stagedResultRef: string): string {
  const ref = requireWorkerResultRef(stagedResultRef);
  return `${WORKER_RESULT_CLEANUP_REF_PREFIX}/${ref.slice(WORKER_RESULT_REF_PREFIX.length + 1)}`;
}

export function isWorkerWorkspaceResultCleanupRef(ref: string): boolean {
  return ref.startsWith(`${WORKER_RESULT_CLEANUP_REF_PREFIX}/`);
}

export async function hasWorkerWorkspaceResultRef(params: {
  root: string;
  stagedResultRef: string;
}): Promise<boolean> {
  const ref = requireWorkerResultStorageRef(params.stagedResultRef);
  const storage = await resolveWorkspaceResultStorage(params.root, ref);
  return Boolean(storage.commonDir && readGitRefs(storage.commonDir, [ref]).get(ref));
}

async function stageWorkerWorkspaceResult(
  params: WorkspaceStageInputSource<string> & {
    root: string;
    stagingRoot: string;
    stagedResultRef: string;
    buildCacheInputs?: string[];
    assertCurrent?: () => void;
    gitHistory?: WorkerWorkspaceGitHistory;
    gitPackPath?: string;
    parentCommit?: string;
    sharedResultStore?: true;
  },
): Promise<string> {
  const root = await fs.realpath(params.root);
  params.assertCurrent?.();
  const temporary = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-workspace-import-"),
  );
  let storage: WorkspaceResultStorage | undefined;
  try {
    storage = params.sharedResultStore
      ? { root, baseEnv: { ...process.env }, isolated: false }
      : await resolveWorkspaceResultStorage(root, params.stagedResultRef, {
          assertCurrent: params.assertCurrent,
        });
    const inputPath = path.join(temporary, "fast-import");
    await importWorkerWorkspaceHistory({
      ...params,
      ...storage,
      baseRoot: storage.isolated ? root : undefined,
    });
    // Preparation owns only a private input file, never the accepted refs.
    params.assertCurrent?.();
    await prepareWorkspaceStageInput({ ...params, inputPath });
    await using input = await fs.open(inputPath, "r");
    const resultRoot = storage.root;
    return await withWorkspaceResultRefMutation(
      storage.root,
      (queuedEnv) => {
        params.assertCurrent?.();
        return requireGit(resultRoot, ["fast-import", "--quiet"], {
          baseEnv: queuedEnv,
          stdinFileDescriptor: input.fd,
        });
      },
      storage,
    );
  } catch (error) {
    if (storage) {
      const failedStorage = storage;
      await runBestEffortCleanup({
        cleanup: () => deleteEmptyWorkspaceResultStorage(failedStorage),
        onError: (cleanupError) =>
          workspaceLog.warn(
            `worker workspace result cleanup failed: ${boundedWorkerError(cleanupError)}`,
          ),
      });
    }
    throw error;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

export async function readStagedWorkerWorkspaceResult(
  root: string,
  stagedResultRef: string,
  buildCacheInputs?: string[],
) {
  return await computeWorkspaceManifest({
    type: "workspace.manifest.result",
    input: { root, ref: stagedResultRef, buildCacheInputs },
  });
}

type StagedWorkspaceSource = { root: string; stagedResultRef: string; buildCacheInputs?: string[] };

export async function withStagedWorkerWorkspaceResult<T>(
  params: StagedWorkspaceSource,
  use: (snapshot: StagedWorkerWorkspaceResult & { stagingRoot: string }) => Promise<T>,
): Promise<T> {
  return withMaterializedWorkerWorkspaceResult(
    (stagingRoot) =>
      computeWorkspaceManifest({
        type: "workspace.manifest.result",
        input: {
          root: params.root,
          ref: params.stagedResultRef,
          buildCacheInputs: params.buildCacheInputs,
          stagingRoot,
        },
      }),
    use,
  );
}

/** Reconciliation and restaging explicitly request their complete source facts. */
export async function withStagedWorkerWorkspaceManifest<T>(
  params: StagedWorkspaceSource & {
    reconciliation?: { baseManifestRef: string; alreadyAccepted?: boolean };
  },
  use: (snapshot: StagedWorkerWorkspaceInventory & { stagingRoot: string }) => Promise<T>,
): Promise<T> {
  return withMaterializedWorkerWorkspaceResult(
    (stagingRoot) =>
      computeWorkspaceManifest({
        type: "workspace.manifest.staged",
        input: {
          root: params.root,
          ref: params.stagedResultRef,
          buildCacheInputs: params.buildCacheInputs,
          stagingRoot,
          reconciliation: params.reconciliation,
        },
      }),
    use,
  );
}

async function withMaterializedWorkerWorkspaceResult<Snapshot, T>(
  read: (stagingRoot: string) => Promise<Snapshot>,
  use: (snapshot: Snapshot & { stagingRoot: string }) => Promise<T>,
): Promise<T> {
  const stagingRoot = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-checkpoint-payload-"),
  );
  try {
    const snapshot = await read(stagingRoot);
    return await use({ ...snapshot, stagingRoot });
  } finally {
    await runBestEffortCleanup({
      cleanup: () => fs.rm(stagingRoot, { recursive: true, force: true }),
      onError: (error) =>
        workspaceLog.warn(`worker workspace staging cleanup failed: ${boundedWorkerError(error)}`),
    });
  }
}

export async function applyStagedWorkerWorkspaceResult(params: {
  root: string;
  stagedResultRef: string;
  expectedBaseManifestRef: string;
  alreadyAccepted?: boolean;
  additionalPaths?: ReadonlySet<string>;
  journal: WorkerWorkspaceReconciliationJournalAdapter;
  assertCurrent?: () => void;
  publishAcceptedManifest?: (
    accepted: Omit<WorkerWorkspaceApplyResult, "verifyLocalStable">,
  ) => Promise<void>;
}): Promise<WorkerWorkspaceApplyResult & { changed: boolean }> {
  return await withWorkspaceHashContext(async () => {
    const root = await fs.realpath(params.root);
    return await withStagedWorkerWorkspaceManifest(
      {
        root,
        stagedResultRef: params.stagedResultRef,
        reconciliation: {
          baseManifestRef: params.expectedBaseManifestRef,
          alreadyAccepted: params.alreadyAccepted,
        },
      },
      async (staged) => {
        if (params.alreadyAccepted || staged.baseManifestRef !== params.expectedBaseManifestRef) {
          // An acceptance marker proves the mutations already ran even when omitted
          // local nodes left the manifest ref unchanged. Inspect conflicts; never replay.
          // A base advance proves the same commit-before-acceptance crash window.
          const accepted = await inspectAcceptedWorkerWorkspace({
            root,
            expectedManifestRef: params.expectedBaseManifestRef,
            allowAdvancedLocalState: true,
            reconciliation: staged.reconciliation,
            current: staged.current,
            additionalPaths: params.additionalPaths,
          });
          if (!accepted) {
            throw new Error("Cloud workspace staged result does not match the placement base");
          }
          params.assertCurrent?.();
          // This snapshot can omit host paths published after the worker's baseline.
          // Settlement must preserve the accepted digest for the next worker result.
          return {
            ...accepted,
            changed: staged.changed,
          };
        }
        const applied = await applyStagedWorkerWorkspace({
          root,
          stagingRoot: staged.stagingRoot,
          baseManifestRef: staged.baseManifestRef,
          currentManifestRef: staged.currentManifestRef,
          reconciliation: staged.reconciliation,
          current: staged.current,
          additionalPaths: params.additionalPaths,
          journal: params.journal,
          assertCurrent: params.assertCurrent,
          acceptance: { kind: "reconcile", publish: params.publishAcceptedManifest },
        });
        return { ...applied, changed: staged.changed };
      },
    );
  });
}

async function prepareRequestedWorkerWorkspaceResult(params: {
  request: WorkerLocalWorkspaceReconcileRequest;
  stagingRoot: string;
  currentManifestRef: string;
  baseManifestRaw: string;
  currentManifestRaw: string;
  gitHistory?: WorkerWorkspaceGitHistory;
  gitPackPath?: string;
  unchanged?: WorkerWorkspaceApplyResult;
  additionalPaths?: ReadonlySet<string>;
  publishAcceptedManifest?: (
    accepted: Omit<WorkerWorkspaceApplyResult, "verifyLocalStable">,
  ) => Promise<void>;
}) {
  const stagedResult = params.request.stagedResult;
  const candidateRef = preparedWorkerWorkspaceResultRef(stagedResult.ref);
  const { memo: hashMemo = new Map(), metrics } = activeWorkspaceHashContext() ?? {};
  let appliedWorkspaceResult: WorkerWorkspaceApplyResult | undefined;
  const root = await fs.realpath(params.request.localPath);
  const unchanged = params.unchanged;
  // Exact matches have no result bytes; their durable acceptance still owns completion.
  const commit = unchanged
    ? undefined
    : await stageWorkerWorkspaceResult({
        root,
        stagingRoot: params.stagingRoot,
        stagedResultRef: candidateRef,
        baseManifestRef: params.request.baseManifestRef,
        currentManifestRef: params.currentManifestRef,
        baseManifestRaw: params.baseManifestRaw,
        currentManifestRaw: params.currentManifestRaw,
        gitHistory: params.gitHistory,
        gitPackPath: params.gitPackPath,
        assertCurrent: params.request.assertCurrent,
      });
  const applyPreparedStagedResult = async () => {
    if (unchanged) {
      await unchanged.verifyLocalStable();
      params.request.assertCurrent?.();
      await params.request.journal.commit(unchanged.manifestRef);
      appliedWorkspaceResult = unchanged;
      return;
    }
    appliedWorkspaceResult = await withWorkspaceHashMemo(
      hashMemo,
      async () =>
        await applyStagedWorkerWorkspaceResult({
          root,
          stagedResultRef: candidateRef,
          expectedBaseManifestRef: params.request.baseManifestRef,
          additionalPaths: params.additionalPaths,
          journal: params.request.journal,
          assertCurrent: params.request.assertCurrent,
          publishAcceptedManifest: params.publishAcceptedManifest,
        }),
      metrics,
    );
  };
  return {
    applyPreparedStagedResult,
    ...(unchanged ? { acceptUnchangedStagedResult: applyPreparedStagedResult } : {}),
    getAppliedWorkspaceResult: () => appliedWorkspaceResult,
    verifyLocalStable: async () => {
      const local = appliedWorkspaceResult ?? unchanged;
      if (!local) {
        throw new Error("Cloud workspace staged result has not been applied");
      }
      await local.verifyLocalStable();
    },
    publishStagedResult: async () => {
      if (unchanged) {
        return;
      }
      const storage = await resolveWorkspaceResultStorage(root, candidateRef);
      await updateWorkspaceResultRefs(
        storage.root,
        [{ ref: stagedResult.ref, objectId: commit }, { ref: candidateRef }],
        params.request.assertCurrent,
        storage,
      );
      // Final fences precede publishing. Preserve the canonical ref on any
      // SQLite failure so restart recovery can discover the verified result.
      params.request.assertCurrent?.();
      await stagedResult.record(stagedResult.ref);
      params.request.assertCurrent?.();
    },
    discardPreparedStagedResult: async () => {
      if (!unchanged) {
        await deleteStagedWorkerWorkspaceResult({
          root: params.request.localPath,
          stagedResultRef: candidateRef,
          assertCurrent: params.request.assertCurrent,
        });
      }
    },
  };
}

export async function deleteStagedWorkerWorkspaceResult(params: {
  root: string;
  stagedResultRef: string;
  assertCurrent?: () => void;
}): Promise<void> {
  const root = await fs.realpath(params.root);
  const stagedResultRef = requireWorkerResultStorageRef(params.stagedResultRef);
  const storage = await resolveWorkspaceResultStorage(root, stagedResultRef);
  await updateWorkspaceResultRefs(
    storage.root,
    [
      { ref: stagedResultRef },
      ...(stagedResultRef.startsWith(`${WORKER_RESULT_REF_PREFIX}/`)
        ? [{ ref: preparedWorkerWorkspaceResultRef(stagedResultRef) }]
        : []),
    ],
    params.assertCurrent,
    storage,
  );
  await deleteEmptyWorkspaceResultStorage(storage);
}

export async function moveStagedWorkerWorkspaceResultToCleanup(params: {
  root: string;
  stagedResultRef: string;
  assertCurrent?: () => void;
}): Promise<string> {
  const root = await fs.realpath(params.root);
  const stagedResultRef = requireWorkerResultRef(params.stagedResultRef);
  const cleanupRef = cleanupWorkerWorkspaceResultRef(stagedResultRef);
  const storage = await resolveWorkspaceResultStorage(root, stagedResultRef);
  const commit = await requireGit(
    storage.root,
    ["rev-parse", `${stagedResultRef}^{commit}`],
    storage,
  );
  // Complete the ref move before removing the SQLite fence, keeping an
  // inspectable result on either side of a crash.
  await updateWorkspaceResultRefs(
    storage.root,
    [
      { ref: cleanupRef, objectId: commit },
      { ref: stagedResultRef },
      { ref: preparedWorkerWorkspaceResultRef(stagedResultRef) },
    ],
    params.assertCurrent,
    storage,
  );
  return cleanupRef;
}

export async function restoreStagedWorkerWorkspaceResultFromCleanup(params: {
  root: string;
  cleanupRef: string;
  stagedResultRef: string;
  assertCurrent?: () => void;
}): Promise<void> {
  const root = await fs.realpath(params.root);
  const cleanupRef = requireWorkerResultStorageRef(params.cleanupRef);
  if (!isWorkerWorkspaceResultCleanupRef(cleanupRef)) {
    throw new Error("Cloud workspace cleanup result reference is invalid");
  }
  const stagedResultRef = requireWorkerResultRef(params.stagedResultRef);
  const storage = await resolveWorkspaceResultStorage(root, cleanupRef);
  const commit = await requireGit(storage.root, ["rev-parse", `${cleanupRef}^{commit}`], storage);
  await updateWorkspaceResultRefs(
    storage.root,
    [{ ref: stagedResultRef, objectId: commit }, { ref: cleanupRef }],
    params.assertCurrent,
    storage,
  );
}

export async function deleteWorkerWorkspaceResultCleanupRefs(params: {
  root: string;
  retainedRefs?: () => ReadonlySet<string> | Promise<ReadonlySet<string>>;
}): Promise<void> {
  const root = await fs.realpath(params.root);
  const output = await requireGit(root, [
    "for-each-ref",
    "--format=%(refname)",
    `${WORKER_RESULT_CLEANUP_REF_PREFIX}/`,
  ]);
  const cleanupRefs = output.split("\n").filter(Boolean);
  if (cleanupRefs.length > 0) {
    await updateWorkspaceResultRefs(root, async () => {
      // Read fences after inventory and the shared ref queue wait. Later
      // claims cannot appear in these immutable claim refs.
      const retainedRefs = await params.retainedRefs?.();
      return cleanupRefs
        .map(requireWorkerResultStorageRef)
        .filter((ref) => !retainedRefs?.has(ref))
        .map((ref) => ({ ref }));
    });
  }
}

export const workerWorkspaceResultStaging = {
  prepareRequestedWorkerWorkspaceResult,
  stageWorkerWorkspaceResult,
};
