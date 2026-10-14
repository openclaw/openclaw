import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { readConfigMachineStateRowInDatabase } from "../../state/config-machine-state.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { serializeCronLoadError } from "./load-error.js";
import type { CronStoreWorkerOperations } from "./load-worker.types.js";
import { loadCronStoreFromDatabase } from "./load.kernel.js";
import { resolveSelectedCronJobsStorePath } from "./paths.js";

function resolveDefaultCronStoreKey(database: OpenClawStateDatabase): string {
  const row = readConfigMachineStateRowInDatabase(database.db, "cron.store");
  const value: unknown = row ? JSON.parse(row.value_json) : undefined;
  return resolveSelectedCronJobsStorePath(
    typeof value === "string" ? value.trim() : undefined,
    getSqliteWorkerStateContext().environment,
  );
}

export function loadMutableCronStoreInWorker(
  database: OpenClawStateDatabase,
  selectedStoreKey: string | undefined,
): CronStoreWorkerOperations["cron.loadMutable"]["output"] {
  const storeKey = selectedStoreKey ?? resolveDefaultCronStoreKey(database);
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
