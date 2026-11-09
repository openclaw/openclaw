import {
  mergeWorkspaceSetupStateInDatabase,
  rollbackWorkspaceBootstrapSeedInDatabase,
} from "../agents/workspace-state-store.worker.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { assertOpenClawStateLeasesWorkerOwnedInTransaction } from "../state/openclaw-state-lease-worker.js";
import type { WorkerWriteOperationContext } from "../state/worker-operation-registry.js";
import type { TemplateAddStateCommand } from "./add-state-worker-contract.js";

/** One finite Template Add state change runs entirely on the shared SQLite actor. */
export function executeTemplateAddStateCommand(
  command: TemplateAddStateCommand,
  { write, writeAdmitted }: WorkerWriteOperationContext,
) {
  const apply = (database: OpenClawStateDatabase) =>
    command.type === "templates.add.rollbackBootstrapSeed"
      ? rollbackWorkspaceBootstrapSeedInDatabase(
          database,
          command.input.workspaceDir,
          command.input.bootstrapSeededAt,
        )
      : mergeWorkspaceSetupStateInDatabase(
          database,
          command.input.workspaceDir,
          { bootstrapSeededAt: command.input.bootstrapSeededAt, bootstrapSupplied: true },
          command.input.nowMs,
        );
  const { leases } = command.input;
  if (leases) {
    return write((database) => {
      assertOpenClawStateLeasesWorkerOwnedInTransaction(database.db, leases);
      const result = apply(database);
      assertOpenClawStateLeasesWorkerOwnedInTransaction(database.db, leases, "commit");
      return result;
    });
  }
  return writeAdmitted(apply, { transactionEnvironment: "process" });
}
