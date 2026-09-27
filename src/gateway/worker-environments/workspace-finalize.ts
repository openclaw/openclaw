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

async function runFinalFenceStep(
  operation: () => Promise<void>,
  reclaimDisposition: WorkerWorkspaceFinalFenceError["reclaimDisposition"],
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    throw new WorkerWorkspaceFinalFenceError(error, reclaimDisposition);
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

function reportWorkspaceReconcile(
  reconciliation: WorkerWorkspaceReconcileResult,
  outcome: WorkspaceReconcileOutcome,
): void {
  const reporter = workspaceReconcileReporters.get(reconciliation);
  workspaceReconcileReporters.delete(reconciliation);
  reporter?.(outcome);
}

/** Rechecks both owners after renewing the remote quiescence lease. */
export async function verifyReconciledWorkspaceFinal(
  reconciliation: WorkerWorkspaceReconcileResult,
  quiescence: WorkerWorkspaceQuiescence,
): Promise<WorkerWorkspaceApplyResult | undefined> {
  let succeeded = false;
  try {
    if (reconciliation.publishStagedResult) {
      try {
        // Fence the prepared remote capture before quiescence renewal can enroll late writers.
        await runFinalFenceStep(() => reconciliation.verifyStable(), "retry");
        // Renew quiescence and freeze any writers that appeared after the prepared capture.
        await runFinalFenceStep(() => quiescence.assertActive(), "retry");
        // Keep this fence: a late writer can mutate before renewal enrolls and SIGSTOPs it.
        await runFinalFenceStep(() => reconciliation.verifyStable(), "retry");
        await reconciliation.applyPreparedStagedResult?.();
        await reconciliation.verifyLocalStable();
        // Renew after apply so lease expiry cannot race the final publish gate.
        await runFinalFenceStep(() => quiescence.assertActive(), "preserve-result");
        // Recheck the remote owner after apply before publishing the prepared result.
        await runFinalFenceStep(() => reconciliation.verifyStable(), "preserve-result");
        await runFinalFenceStep(() => reconciliation.verifyLocalStable(), "preserve-result");
        await reconciliation.publishStagedResult();
        const applied = reconciliation.getAppliedWorkspaceResult?.();
        succeeded = true;
        return applied;
      } catch (error) {
        await reconciliation.discardPreparedStagedResult?.().catch(() => undefined);
        throw error;
      }
    }
    const disposition = reconciliation.changed ? "preserve-result" : "retry";
    await runFinalFenceStep(() => reconciliation.verifyStable(), disposition);
    await runFinalFenceStep(() => reconciliation.verifyLocalStable(), disposition);
    await runFinalFenceStep(() => quiescence.assertActive(), disposition);
    await runFinalFenceStep(() => reconciliation.verifyStable(), disposition);
    await runFinalFenceStep(() => reconciliation.verifyLocalStable(), disposition);
    const applied = reconciliation.getAppliedWorkspaceResult?.();
    succeeded = true;
    return applied;
  } finally {
    reportWorkspaceReconcile(reconciliation, succeeded ? "succeeded" : "failed");
  }
}
