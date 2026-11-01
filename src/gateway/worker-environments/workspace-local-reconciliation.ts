import { selectLocalWorkspaceCanonicalPaths } from "./local-workspace-inventory.js";
import type {
  WorkerLocalWorkspaceReconcileRequest,
  WorkerWorkspaceReconcileResult,
} from "./tunnel-contract.js";
import {
  pruneWorkspaceHashMemo,
  withWorkspaceHashMemo,
  type WorkspaceHashMemo,
} from "./workspace-hash-memo.js";
import type { WorkerWorkspaceManifest } from "./workspace-manifest.js";
import {
  type WorkerWorkspaceApplyResult,
  inspectAcceptedWorkerWorkspace,
  recoverWorkerWorkspaceReconciliation,
} from "./workspace-reconcile.js";
import type { WorkerWorkspaceGitHistory } from "./workspace-result-inventory.js";
import { workerWorkspaceResultStaging } from "./workspace-result-staging.js";

/** Accepts authenticated transport snapshots through one local journal and result owner. */
export async function prepareLocalWorkspaceReconciliation(params: {
  request: WorkerLocalWorkspaceReconcileRequest;
  hashMemo: WorkspaceHashMemo;
}) {
  const { request, hashMemo } = params;
  const pending = await request.journal.load();
  if (pending) {
    await recoverWorkerWorkspaceReconciliation({
      root: request.localPath,
      journal: pending,
      assertCurrent: request.assertCurrent,
    });
    request.assertCurrent?.();
    await request.journal.abort();
  }
  pruneWorkspaceHashMemo(hashMemo);
  const runLocal = <T>(operation: () => Promise<T>): Promise<T> =>
    withWorkspaceHashMemo(hashMemo, operation);

  return async (snapshot: {
    stagingRoot: string;
    base: WorkerWorkspaceManifest;
    current: WorkerWorkspaceManifest;
    baseRaw: string;
    currentRaw: string;
    currentManifestRef: string;
    gitHistory?: WorkerWorkspaceGitHistory;
    gitPackPath?: string;
    publishAcceptedManifest: (
      accepted: Omit<WorkerWorkspaceApplyResult, "verifyLocalStable">,
    ) => Promise<void>;
    manifestRef: () => string;
    verifyStable: () => Promise<void>;
  }): Promise<WorkerWorkspaceReconcileResult> => {
    const additionalPaths = snapshot.current.baseCommit
      ? await selectLocalWorkspaceCanonicalPaths({
          root: request.localPath,
          admittedPaths: "[]",
          assertCurrent: () => request.assertCurrent?.(),
        })
      : undefined;
    const inspected =
      snapshot.currentManifestRef === request.baseManifestRef
        ? await runLocal(() =>
            inspectAcceptedWorkerWorkspace({
              root: request.localPath,
              expectedManifestRef: request.baseManifestRef,
              base: snapshot.base,
              current: snapshot.current,
              additionalPaths,
            }),
          )
        : undefined;
    const hasWorkerCommits =
      snapshot.gitHistory && snapshot.gitHistory.headCommit !== snapshot.gitHistory.baseCommit;
    const unchanged =
      !hasWorkerCommits && inspected?.conflictPaths.length === 0 ? inspected : undefined;
    if (!unchanged) {
      await snapshot.verifyStable();
    }
    const staged = await runLocal(() =>
      workerWorkspaceResultStaging.prepareRequestedWorkerWorkspaceResult({
        request,
        stagingRoot: snapshot.stagingRoot,
        currentManifestRef: snapshot.currentManifestRef,
        baseManifestRaw: snapshot.baseRaw,
        currentManifestRaw: snapshot.currentRaw,
        gitHistory: snapshot.gitHistory,
        gitPackPath: snapshot.gitPackPath,
        publishAcceptedManifest: snapshot.publishAcceptedManifest,
        unchanged,
        additionalPaths,
      }),
    );
    const { acceptUnchangedStagedResult } = staged;
    return {
      get manifestRef() {
        return snapshot.manifestRef();
      },
      changed: snapshot.currentManifestRef !== request.baseManifestRef,
      verifyStable: snapshot.verifyStable,
      ...staged,
      applyPreparedStagedResult: () => runLocal(staged.applyPreparedStagedResult),
      ...(acceptUnchangedStagedResult
        ? {
            acceptUnchangedStagedResult: () => runLocal(acceptUnchangedStagedResult),
          }
        : {}),
      verifyLocalStable: () => runLocal(() => staged.verifyLocalStable()),
    };
  };
}
