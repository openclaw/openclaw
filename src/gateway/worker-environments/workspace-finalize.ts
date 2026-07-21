import type {
  WorkerWorkspaceQuiescence,
  WorkerWorkspaceReconcileResult,
} from "./tunnel-contract.js";
import type { WorkerWorkspaceApplyResult } from "./workspace-reconcile.js";

export class WorkerWorkspaceQuiescenceError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Worker workspace quiescence failed", { cause });
    this.name = "WorkerWorkspaceQuiescenceError";
  }
}

async function assertQuiescenceActive(quiescence: WorkerWorkspaceQuiescence): Promise<void> {
  try {
    await quiescence.assertActive();
  } catch (error) {
    throw new WorkerWorkspaceQuiescenceError(error);
  }
}

/** Rechecks both owners after renewing the remote quiescence lease. */
export async function verifyReconciledWorkspaceFinal(
  reconciliation: WorkerWorkspaceReconcileResult,
  quiescence: WorkerWorkspaceQuiescence,
): Promise<WorkerWorkspaceApplyResult | undefined> {
  if (reconciliation.applyPreparedStagedResult && reconciliation.publishStagedResult) {
    try {
      await reconciliation.verifyStable();
      await assertQuiescenceActive(quiescence);
      await reconciliation.verifyStable();
      await reconciliation.applyPreparedStagedResult();
      await reconciliation.verifyLocalStable();
      // Applying can outlive the lease renewed above. Only publish the candidate
      // after both owners pass a fresh fence, so restart recovery cannot adopt it early.
      await assertQuiescenceActive(quiescence);
      await reconciliation.verifyStable();
      await reconciliation.verifyLocalStable();
      await reconciliation.publishStagedResult();
      return reconciliation.getAppliedWorkspaceResult?.();
    } catch (error) {
      await reconciliation.discardPreparedStagedResult?.().catch(() => undefined);
      throw error;
    }
  }
  await reconciliation.verifyStable();
  await reconciliation.verifyLocalStable();
  await assertQuiescenceActive(quiescence);
  await reconciliation.verifyStable();
  await reconciliation.verifyLocalStable();
  return reconciliation.getAppliedWorkspaceResult?.();
}
