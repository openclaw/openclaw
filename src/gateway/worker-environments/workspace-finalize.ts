import type {
  WorkerWorkspaceQuiescence,
  WorkerWorkspaceReconcileResult,
} from "./tunnel-contract.js";
import type { WorkerWorkspaceApplyResult } from "./workspace-reconcile.js";

export class WorkerWorkspaceFinalFenceError extends Error {
  readonly reclaimDisposition: "retry" | "preserve-result";

  constructor(cause: unknown, reclaimDisposition: "retry" | "preserve-result") {
    super(cause instanceof Error ? cause.message : "Worker workspace quiescence failed", { cause });
    this.name = "WorkerWorkspaceFinalFenceError";
    this.reclaimDisposition = reclaimDisposition;
  }
}

/** Rechecks both owners after renewing the remote quiescence lease. */
export async function verifyReconciledWorkspaceFinal(
  reconciliation: WorkerWorkspaceReconcileResult,
  quiescence: WorkerWorkspaceQuiescence,
): Promise<WorkerWorkspaceApplyResult | undefined> {
  const acceptUnchanged = reconciliation.acceptUnchangedStagedResult;
  let disposition: WorkerWorkspaceFinalFenceError["reclaimDisposition"] = "retry";
  const fence = async (operation: () => Promise<void>) => {
    try {
      await operation();
    } catch (error) {
      throw new WorkerWorkspaceFinalFenceError(error, disposition);
    }
  };
  try {
    // A late writer can mutate before renewal enrolls and SIGSTOPs it.
    await fence(() => quiescence.assertActive());
    await fence(() => reconciliation.verifyStable());
    if (acceptUnchanged) {
      await fence(acceptUnchanged);
    } else {
      await reconciliation.applyPreparedStagedResult?.();
      await reconciliation.verifyLocalStable();
      // Applied results must survive a lost lease or final verification failure.
      disposition = "preserve-result";
      await fence(() => quiescence.assertActive());
      await fence(() => reconciliation.verifyStable());
      await fence(() => reconciliation.verifyLocalStable());
    }
    await reconciliation.publishStagedResult();
    const applied = reconciliation.getAppliedWorkspaceResult?.();
    return applied;
  } catch (error) {
    await reconciliation.discardPreparedStagedResult().catch(() => undefined);
    throw error;
  }
}
