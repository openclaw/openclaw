import type { UpdateRunRecord } from "./update-run-record.js";

// Repair and activation are the only phases that can change the installation or its state.
const CHANGING_PHASES = new Set(["repairing", "activating", "restarting", "verifying"]);

/**
 * A finished update failure that never left admission, staging, or validation changed neither
 * the installation nor its state, so its original-state capture has nothing left to recover.
 * Only the update command takes that capture, and it records activation before any mutation;
 * other runs (finalize, repair, Gateway-driven children) never qualify.
 */
export function isNeverActivatedFailedUpdate(run: UpdateRunRecord): boolean {
  const capture = run.origin.updateRecoveryCapture;
  const recovery = run.verification.recovery;
  return (
    run.status === "failed" &&
    run.finishedAtMs !== null &&
    // Phase receipts are required history; without the admission receipt nothing is proven.
    run.steps.some((step) => step.step === "requested") &&
    // A compacted capture receipt keeps the capture protected.
    run.steps.some((step) => step.step === "original-state-capture") &&
    !run.steps.some((step) => CHANGING_PHASES.has(step.step)) &&
    run.repair.length === 0 &&
    !(recovery?.serviceRestartSafe === false && recovery.dataAtRisk) &&
    !run.verification.rollbackOutcome &&
    !capture?.doctorCompleted &&
    !capture?.configWrites.length
  );
}
