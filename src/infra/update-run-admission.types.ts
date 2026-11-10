import type { UpdateRunReconciliationInput } from "./update-run-reconciliation.types.js";

export type UpdateRunAdmissionReadCommand =
  | { type: "updateRuns.recoveryAdmission" }
  | { type: "updateRuns.reconciliationCandidates"; input: UpdateRunReconciliationInput }
  | { type: "updateRuns.reconciliationCandidate"; runId: string };

export function isUpdateRunAdmissionReadCommand(command: {
  type: string;
}): command is UpdateRunAdmissionReadCommand {
  return (
    command.type === "updateRuns.recoveryAdmission" ||
    command.type === "updateRuns.reconciliationCandidates" ||
    command.type === "updateRuns.reconciliationCandidate"
  );
}
