import type {
  WorkerLocalWorkspaceReconcileRequest,
  WorkerWorkspaceReconcileResult,
} from "./tunnel-contract.js";
import {
  measureLocalWorkspaceReconciliation,
  pruneWorkspaceHashMemo,
  withWorkspaceHashMemo,
  type WorkspaceHashMemo,
  type WorkspaceReconcileMetrics,
} from "./workspace-hash-memo.js";
import type { WorkerWorkspaceManifest } from "./workspace-manifest.js";
import {
  applyStagedWorkerWorkspace,
  recoverWorkerWorkspaceReconciliation,
} from "./workspace-reconcile.js";
import { workerWorkspaceResultStaging } from "./workspace-result-staging.js";

/** Accepts authenticated transport snapshots through one local journal and result owner. */
export async function prepareLocalWorkspaceReconciliation(params: {
  request: WorkerLocalWorkspaceReconcileRequest;
  hashMemo: WorkspaceHashMemo;
  metrics: WorkspaceReconcileMetrics;
}) {
  const { request, hashMemo, metrics } = params;
  const pending = request.journal.load();
  if (pending) {
    await recoverWorkerWorkspaceReconciliation({ root: request.localPath, journal: pending });
    request.journal.abort();
  }
  pruneWorkspaceHashMemo(hashMemo);
  const runLocal = <T>(operation: () => Promise<T>): Promise<T> =>
    measureLocalWorkspaceReconciliation(metrics, () =>
      withWorkspaceHashMemo(hashMemo, operation, metrics.gateway),
    );

  return async (snapshot: {
    stagingRoot: string;
    base: WorkerWorkspaceManifest;
    current: WorkerWorkspaceManifest;
    baseRaw: string;
    currentRaw: string;
    currentManifestRef: string;
    publishAcceptedManifest: (accepted: {
      manifestRef: string;
      manifest: WorkerWorkspaceManifest;
      conflictPaths: string[];
    }) => Promise<void>;
    manifestRef: () => string;
    verifyStable: () => Promise<void>;
  }): Promise<WorkerWorkspaceReconcileResult> => {
    // Catch writes that raced the inbound transfer before either staging or local acceptance.
    // Finalization repeats the remote fence after apply, before releasing its owner.
    await snapshot.verifyStable();
    if (request.stagedResult) {
      const staged = await runLocal(() =>
        workerWorkspaceResultStaging.prepareRequestedWorkerWorkspaceResult({
          request,
          stagingRoot: snapshot.stagingRoot,
          currentManifestRef: snapshot.currentManifestRef,
          baseManifestRaw: snapshot.baseRaw,
          currentManifestRaw: snapshot.currentRaw,
          publishAcceptedManifest: snapshot.publishAcceptedManifest,
        }),
      );
      return {
        get manifestRef() {
          return snapshot.manifestRef();
        },
        changed: snapshot.currentManifestRef !== request.baseManifestRef,
        verifyStable: snapshot.verifyStable,
        ...staged,
        applyPreparedStagedResult: () => runLocal(() => staged.applyPreparedStagedResult()),
        verifyLocalStable: () => runLocal(() => staged.verifyLocalStable()),
      };
    }
    const applied = await runLocal(() =>
      applyStagedWorkerWorkspace({
        root: request.localPath,
        stagingRoot: snapshot.stagingRoot,
        baseManifestRef: request.baseManifestRef,
        currentManifestRef: snapshot.currentManifestRef,
        base: snapshot.base,
        current: snapshot.current,
        journal: request.journal,
        acceptance: { kind: "reconcile", publish: snapshot.publishAcceptedManifest },
      }),
    );
    return {
      get manifestRef() {
        return snapshot.manifestRef();
      },
      changed: snapshot.currentManifestRef !== request.baseManifestRef,
      verifyStable: snapshot.verifyStable,
      getAppliedWorkspaceResult: () => applied,
      verifyLocalStable: () => runLocal(() => applied.verifyLocalStable()),
    };
  };
}
