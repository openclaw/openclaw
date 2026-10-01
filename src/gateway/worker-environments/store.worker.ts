import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createWorkerEnvironmentCommitAdmission } from "./store-commit-authority.js";
import { reconcileAttachedSessionOwners } from "./store-mutations.js";
import { readWorkerEnvironmentFacts } from "./store-row-codec.js";
import type { WorkerEnvironmentWorkerOperations } from "./store-worker-contract.js";
import { readTotalChanges } from "./store-write.js";
import { createWorkerEnvironmentStoreKernel } from "./store.kernel.js";
import { pruneObservedTerminalWorkerEnvironments } from "./terminal-environment-retention.js";

const admitted = () => {};
type Command = SqliteWorkerCommand<WorkerEnvironmentWorkerOperations>;

export function executeWorkerEnvironmentCommand(command: Command, database: OpenClawStateDatabase) {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const now = () => command.input.nowMs ?? Date.now();
      const store = createWorkerEnvironmentStoreKernel({
        database,
        now,
        write: (operation) => operation(db),
      });
      const changesBefore = readTotalChanges(db);
      const touched = new Set<string>();
      const touch = (id: string) => touched.add(id.trim());
      const result = (() => {
        switch (command.type) {
          case "workerEnvironments.initialize":
            for (const id of reconcileAttachedSessionOwners(db, now())) {
              touch(id);
            }
            return undefined;
          case "workerEnvironments.createIntent":
            touch(command.input.input.environmentId);
            return store.createIntent(command.input.input);
          case "workerEnvironments.ensureNodeEnrollment":
            touch(command.input.input);
            return store.ensureNodeEnrollment(command.input.input);
          case "workerEnvironments.revokeEnvironmentCredential":
            touch(command.input.input.environmentId);
            return store.revokeEnvironmentCredential(command.input.input);
          case "workerEnvironments.reconcileSharedHost":
            touch(command.input.input.environmentId);
            return store.reconcileSharedHost(command.input.input);
          case "workerEnvironments.adoptProvisionCleanupFailure":
            touch(command.input.input.environmentId);
            return store.adoptProvisionCleanupFailure(command.input.input);
          case "workerEnvironments.requestDestroy":
            touch(command.input.input.environmentId);
            return store.requestDestroy(command.input.input);
          case "workerEnvironments.refreshBootstrapReceipt":
            touch(command.input.input.environmentId);
            return store.refreshBootstrapReceipt({
              ...command.input.input,
              assertCurrent: admitted,
            });
          case "workerEnvironments.transition": {
            const input = command.input.input;
            touch(input.environmentId);
            return store.transition({
              ...input,
              placementBinding: input.placementBinding
                ? { ...input.placementBinding, assertCurrent: admitted }
                : undefined,
            });
          }
          case "workerEnvironments.renewCredential":
            touch(command.input.input.environmentId);
            return store.renewCredential(command.input.input);
          case "workerEnvironments.markCredentialDelivered":
            touch(command.input.input.environmentId);
            return store.markCredentialDelivered(command.input.input);
          case "workerEnvironments.recordError":
            touch(command.input.input.environmentId);
            return store.recordError(command.input.input);
          case "workerEnvironments.ensurePreparedIntent": {
            const value = store.ensurePreparedIntent({
              ...command.input.input,
              assertCurrent: admitted,
            });
            touch(command.input.input.intent.environmentId);
            if (value) {
              touch(value.environmentId);
            }
            return value;
          }
          case "workerEnvironments.requestPreparedDestroy":
            touch(command.input.input.environmentId);
            return store.requestPreparedDestroy({
              ...command.input.input,
              assertCurrent: admitted,
            });
          case "workerEnvironments.createSessionAttachmentIntent": {
            const previous = store.getSessionAttachmentRecord(command.input.input.sessionId);
            if (previous) {
              touch(previous.environmentId);
            }
            touch(command.input.input.environmentId);
            return store.createSessionAttachmentIntent(command.input.input, admitted);
          }
          case "workerEnvironments.closeSessionAttachment": {
            const value = store.closeSessionAttachment(command.input.input, admitted);
            if (value) {
              touch(value.environmentId);
            }
            return value;
          }
          case "workerEnvironments.cancelSessionAttachmentReservation":
            touch(command.input.input.environmentId);
            return store.cancelSessionAttachmentReservation(command.input.input);
          case "workerEnvironments.touchSessionAttachment":
            touch(command.input.input.environmentId);
            return store.touchSessionAttachment(command.input.input, admitted);
          case "workerEnvironments.pruneTerminalEnvironments": {
            const { approved } = command.input.input;
            for (const row of approved) {
              touch(row.environment_id);
            }
            return pruneObservedTerminalWorkerEnvironments({
              observed: approved,
              write: (operation) => operation(db),
            });
          }
        }
      })();
      const receipt = {
        result,
        changed: readTotalChanges(db) !== changesBefore,
        facts: readWorkerEnvironmentFacts(db, [...touched]),
      };
      deferSqliteWorkerCommitReceipt(db, receipt);
      requestSqliteWorkerOperationAdmission({
        stage: "commit",
        facts: createWorkerEnvironmentCommitAdmission(receipt.facts),
      });
      return receipt;
    },
    { database },
    { operationLabel: command.type },
  );
}
