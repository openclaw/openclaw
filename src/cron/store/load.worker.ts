import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { serializeCronLoadError } from "./load-error.js";
import type { CronStoreWorkerOperations } from "./load-worker.types.js";
import { loadCronStoreFromDatabase } from "./load.kernel.js";
import { retainCronReceiptAuthorityPublication } from "./receipt-authority-publication.js";

export function loadMutableCronStoreInWorker(
  database: OpenClawStateDatabase,
  storeKey: string,
): CronStoreWorkerOperations["cron.loadMutable"]["output"] {
  let repairCommits = 0;
  try {
    const loaded = loadCronStoreFromDatabase(database.db, storeKey, {
      write: (operation, operationLabel) =>
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
            const result = operation(db);
            retainCronReceiptAuthorityPublication(db);
            return result;
          },
          { database, env: getSqliteWorkerStateContext().environment },
          { operationLabel },
        ),
      committed: () => {
        repairCommits += 1;
      },
    });
    return { ok: true, loaded, repairCommits };
  } catch (error) {
    // Earlier repair transactions remain committed if a later load stage fails.
    return { ok: false, error: serializeCronLoadError(error), repairCommits };
  }
}
