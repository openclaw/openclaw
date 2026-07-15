import type {
  WorkerWorkspaceQuiescence,
  WorkerWorkspaceReconcileResult,
} from "./tunnel-contract.js";

/** Proves remote stability, renews quiescence, then catches local edits made during renewal. */
export async function verifyReconciledWorkspaceFinal(
  reconciliation: WorkerWorkspaceReconcileResult,
  quiescence: WorkerWorkspaceQuiescence,
): Promise<void> {
  await reconciliation.verifyStable();
  await reconciliation.verifyLocalStable();
  await quiescence.assertActive();
  await reconciliation.verifyLocalStable();
}
