import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { serializeCronLoadError } from "./load-error.js";
import type { CronStoreWorkerOperations } from "./load-worker.types.js";
import { loadCronStoreFromDatabase } from "./load.kernel.js";
import { requireCronStoreSelection, resolveCronStoreSelectionInDatabase } from "./paths.js";

function resolveDefaultCronStoreKey(
  database: OpenClawStateDatabase,
  defaultStorePath?: string,
): string {
  return requireCronStoreSelection(
    resolveCronStoreSelectionInDatabase(
      database.db,
      undefined,
      getSqliteWorkerStateContext().environment,
      defaultStorePath,
    ),
  ).storeKey;
}

export function loadMutableCronStoreInWorker(
  database: OpenClawStateDatabase,
  selectedStoreKey: string | undefined,
  defaultStorePath?: string,
): CronStoreWorkerOperations["cron.loadMutable"]["output"] {
  const storeKey = selectedStoreKey ?? resolveDefaultCronStoreKey(database, defaultStorePath);
  let repairCommits = 0;
  try {
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
    return { ok: true, storeKey, loaded, repairCommits };
  } catch (error) {
    // Earlier repair transactions remain committed if a later load stage fails.
    return { ok: false, storeKey, error: serializeCronLoadError(error), repairCommits };
  }
}
