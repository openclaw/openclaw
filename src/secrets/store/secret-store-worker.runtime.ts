import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import type { SecretStoreWorkerOperations } from "./secret-store-worker-contract.js";
import { stageSecretStoreEntryWrite, rollbackSecretStoreEntryWrite } from "./secret-store.js";

/** Worker-only persistence boundary: every credential stage/compensation retains both live grants. */
export function executeSecretStoreWorkerCommand(
  command: SqliteWorkerCommand<SecretStoreWorkerOperations>,
  database: OpenClawStateDatabaseOptions,
) {
  return runOpenClawStateWriteTransaction(
    () => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const result =
        command.type === "secrets.store.stage"
          ? stageSecretStoreEntryWrite({ ...command.input, database })
          : rollbackSecretStoreEntryWrite({ ...command.input, database });
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return result;
    },
    database,
    { operationLabel: command.type },
  );
}
