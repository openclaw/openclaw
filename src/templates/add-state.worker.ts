import { DEFAULT_BOOTSTRAP_FILENAME } from "../agents/workspace-bootstrap-policy.js";
import { captureWorkspaceStateReceipt } from "../agents/workspace-state-publication.js";
import {
  readWorkspaceStateSnapshotForDirectoryInDatabase,
  replaceWorkspaceAttestationInDatabase,
} from "../agents/workspace-state-store.kernel.js";
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
    captureWorkspaceStateReceipt(database.db, () => {
      if (command.type === "templates.add.rollbackBootstrapSeed") {
        return rollbackWorkspaceBootstrapSeedInDatabase(
          database,
          command.input.workspaceDir,
          command.input.bootstrapSeededAt,
        );
      }
      const { workspaceDir, bootstrapSha256 } = command.input;
      const snapshot = readWorkspaceStateSnapshotForDirectoryInDatabase({ workspaceDir, database });
      const generatedHashes = new Map(snapshot.attestation?.generatedHashes);
      generatedHashes.set(DEFAULT_BOOTSTRAP_FILENAME, bootstrapSha256);
      replaceWorkspaceAttestationInDatabase(database, {
        workspaceDir,
        attestedAtMs: Date.now(),
        generatedHashes,
      });
      return mergeWorkspaceSetupStateInDatabase(
        database,
        command.input.workspaceDir,
        { bootstrapSeededAt: command.input.bootstrapSeededAt },
        command.input.nowMs,
      );
    });
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
