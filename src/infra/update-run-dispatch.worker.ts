import type { ExistingOpenClawStateWriter } from "../state/openclaw-state-db-existing-write.js";
import {
  SqliteWorkerAdmissionTimeoutError,
  type SqliteWorkerCommand,
} from "./sqlite-worker-contract.js";
import type { UpdateRunLedgerOptions } from "./update-run-codec.js";
import { persistInterruptedUpdateObservation } from "./update-run-interruption-store.js";
import type { UpdateRunWorkerOperations } from "./update-run-mutation.types.js";
import {
  recordUpdateRunMutationInWorker,
  withUpdateRunWriteAdmission,
} from "./update-run-mutation.worker.js";
import { reconcileUpdateRunCandidatesInWorker } from "./update-run-reconciliation.worker.js";
import { isRequiredUpdateRunStep } from "./update-run-write.js";

export { openUpdateRunWriter } from "./update-run-mutation.worker.js";

export function isUpdateRunWorkerCommand(command: {
  type: string;
  input: unknown;
}): command is SqliteWorkerCommand<UpdateRunWorkerOperations> {
  return command.type.startsWith("updateRuns.");
}

export function executeUpdateRunCommand(
  command: SqliteWorkerCommand<UpdateRunWorkerOperations>,
  options: UpdateRunLedgerOptions,
  writer: () => ExistingOpenClawStateWriter,
): UpdateRunWorkerOperations[keyof UpdateRunWorkerOperations]["output"] {
  try {
    return withUpdateRunWriteAdmission((assertCurrent) => {
      if (command.type === "updateRuns.reconcile") {
        return reconcileUpdateRunCandidatesInWorker(command.input, options, assertCurrent);
      }
      if (command.type === "updateRuns.reconcileInterrupted") {
        return persistInterruptedUpdateObservation(command.input, options, assertCurrent);
      }
      return recordUpdateRunMutationInWorker(command, options, assertCurrent, writer);
    });
  } catch (cause) {
    if (!(cause instanceof SqliteWorkerAdmissionTimeoutError)) {
      throw cause;
    }
    // Expired admission certifies rollback. Progress is advisory even while
    // recovery exclusion is required; no mutation was accepted by these attempts.
    if (command.type === "updateRuns.recordStep" && !isRequiredUpdateRunStep(command.input.step)) {
      return { kind: "bookkeeping-skipped" };
    }
    throw new Error(
      "Update history could not obtain commit admission after 3 attempts. The transaction was rolled back; check storage performance before retrying the update.",
      { cause },
    );
  }
}
