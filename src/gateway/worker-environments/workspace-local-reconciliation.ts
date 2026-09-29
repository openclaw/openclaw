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
  type WorkerWorkspaceApplyResult,
  inspectAcceptedWorkerWorkspace,
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
    await recoverWorkerWorkspaceReconciliation({
      root: request.localPath,
      journal: pending,
      assertCurrent: request.assertCurrent,
    });
    request.assertCurrent?.();
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
    publishAcceptedManifest: (
      accepted: Omit<WorkerWorkspaceApplyResult, "verifyLocalStable">,
    ) => Promise<void>;
    manifestRef: () => string;
    verifyStable: () => Promise<void>;
  }): Promise<WorkerWorkspaceReconcileResult> => {
    const inspected =
      snapshot.currentManifestRef === request.baseManifestRef
        ? await runLocal(() =>
            inspectAcceptedWorkerWorkspace({
              root: request.localPath,
              expectedManifestRef: request.baseManifestRef,
              base: snapshot.base,
              current: snapshot.current,
            }),
          )
        : undefined;
    const unchanged = inspected?.conflictPaths.length === 0 ? inspected : undefined;
    // Exact matches stage only the accepted base; finalization fences both sides of renewal
    // before accepting it. Changed results must also fence their inbound bytes before staging.
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
        publishAcceptedManifest: snapshot.publishAcceptedManifest,
        unchanged,
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
