import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  WorkerWorkspaceQuiescence,
  WorkerWorkspaceReconcileResult,
} from "./tunnel-contract.js";
import {
  createWorkspaceReconcileMetrics,
  type WorkspaceReconcileMetrics,
} from "./workspace-hash-memo.js";
import type { WorkerWorkspaceApplyResult } from "./workspace-reconcile.js";

const workspaceReconcileLog = createSubsystemLogger("gateway/worker-workspace");

export class WorkerWorkspaceFinalFenceError extends Error {
  readonly reclaimDisposition: "retry" | "preserve-result";

  constructor(cause: unknown, reclaimDisposition: "retry" | "preserve-result") {
    super(cause instanceof Error ? cause.message : "Worker workspace quiescence failed", { cause });
    this.name = "WorkerWorkspaceFinalFenceError";
    this.reclaimDisposition = reclaimDisposition;
  }
}

type WorkspaceReconcileOutcome = "failed" | "succeeded";

const workspaceReconcileReporters = new WeakMap<
  WorkerWorkspaceReconcileResult,
  (outcome: WorkspaceReconcileOutcome) => void
>();

/** Runs one reconciliation with shared metrics and logs them once the final fence settles. */
export async function runInstrumentedWorkspaceReconcile(
  run: (metrics: WorkspaceReconcileMetrics) => Promise<WorkerWorkspaceReconcileResult>,
): Promise<WorkerWorkspaceReconcileResult> {
  const metrics = createWorkspaceReconcileMetrics();
  const startedAt = performance.now();
  const report = (outcome: WorkspaceReconcileOutcome) => {
    workspaceReconcileLog.debug("worker workspace reconcile completed", {
      outcome,
      durationMs: performance.now() - startedAt,
      ...metrics,
    });
  };
  try {
    const reconciliation = await run(metrics);
    workspaceReconcileReporters.set(reconciliation, report);
    return reconciliation;
  } catch (error) {
    report("failed");
    throw error;
  }
}

/** Rechecks both owners after renewing the remote quiescence lease. */
export async function verifyReconciledWorkspaceFinal(
  reconciliation: WorkerWorkspaceReconcileResult,
  quiescence: WorkerWorkspaceQuiescence,
): Promise<WorkerWorkspaceApplyResult | undefined> {
  let succeeded = false;
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
    succeeded = true;
    return applied;
  } catch (error) {
    await reconciliation.discardPreparedStagedResult().catch(() => undefined);
    throw error;
  } finally {
    const reporter = workspaceReconcileReporters.get(reconciliation);
    workspaceReconcileReporters.delete(reconciliation);
    reporter?.(succeeded ? "succeeded" : "failed");
  }
}
