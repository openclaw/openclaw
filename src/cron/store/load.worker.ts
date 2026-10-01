import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { serializeCronLoadError } from "./load-error.js";
import type { CronStoreWorkerOperations } from "./load-worker.types.js";
import { loadCronStoreFromDatabase } from "./load.kernel.js";

export function loadMutableCronStoreInWorker(
  database: OpenClawStateDatabase,
  storeKey: string,
  jobIds?: readonly string[],
): CronStoreWorkerOperations["cron.loadMutable"]["output"] {
  let repairCommits = 0;
  try {
    if (jobIds) {
      if (jobIds.length === 0) {
        // An empty selection would widen to every row in the partition, which is
        // the cost this read exists to avoid; the caller must ask for real rows.
        throw new Error("cron.loadMutable requires at least one jobId");
      }
      return {
        ok: true,
        loaded: loadCronStoreFromDatabase(database.db, storeKey, undefined, { jobIds }),
        repairCommits,
      };
    }
    const loaded = loadCronStoreFromDatabase(database.db, storeKey, {
      write: (operation, operationLabel) =>
        runOpenClawStateWriteTransaction(
          ({ db }) => operation(db),
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
