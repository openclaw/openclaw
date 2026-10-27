import { mergeWorkspaceSetupStateInDatabase } from "../agents/workspace-state-store.worker.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { assertOpenClawStateLeasesWorkerOwnedInTransaction } from "../state/openclaw-state-lease-worker.js";
import type { WorkerWriteOperationContext } from "../state/worker-operation-registry.js";
import type { ClawAddStateCommand } from "./add-state-worker-contract.js";

/** One finite Claw Add state change runs entirely on the shared SQLite actor. */
export function executeClawAddStateCommand(
  command: ClawAddStateCommand,
  { write, writeAdmitted }: WorkerWriteOperationContext,
) {
  const { workspaceDir, bootstrapSeededAt, nowMs, leases } = command.input;
  const merge = (database: OpenClawStateDatabase) =>
    mergeWorkspaceSetupStateInDatabase(database, workspaceDir, { bootstrapSeededAt }, nowMs);
  if (!leases) {
    return writeAdmitted(merge, { transactionEnvironment: "process" });
  }
  // Lease-held admission grants each stage from lease facts, so publish them in the
  // transaction instead of generic admission facts.
  return write(
    (database) => {
      assertOpenClawStateLeasesWorkerOwnedInTransaction(database.db, leases);
      const result = merge(database);
      assertOpenClawStateLeasesWorkerOwnedInTransaction(database.db, leases, "commit");
      return result;
    },
    { operationLabel: "claws.add.bootstrap-setup" },
  );
}
