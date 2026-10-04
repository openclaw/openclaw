import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type {
  WorkerOperationHandlers,
  WorkerOperations,
} from "../../state/worker-operation-registry.js";
import { writePreparedPoolPresenceDemandInDatabase } from "./prepared-pool-presence-store.worker.js";
import type { PreparedPoolPresenceDemand } from "./prepared-pool-presence.types.js";

export const preparedPoolPresenceOperations = {
  "preparedPoolPresence.write": (
    value: PreparedPoolPresenceDemand | null,
    { open, stateOptions },
  ) =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const result = writePreparedPoolPresenceDemandInDatabase(db, value);
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        return result;
      },
      { database: open(), ...stateOptions() },
      { operationLabel: "prepared-pool.presence-demand.write" },
    ),
} satisfies WorkerOperationHandlers;

export type PreparedPoolPresenceWorkerOperations = WorkerOperations<
  typeof preparedPoolPresenceOperations
>;
