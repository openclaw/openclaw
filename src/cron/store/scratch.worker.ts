import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { writeCronJobScratchInDatabase } from "../scratch-write.kernel.js";
import { loadedCronStoreFromRows, loadCronRows } from "./row-codec.js";
import type { CronRuntimeWorkerOperations } from "./runtime-worker.types.js";
import { CronJobsStoreChangedError } from "./save-error.js";

export function writeCronScratchInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.writeScratch"]["input"],
): CronRuntimeWorkerOperations["cron.writeScratch"]["output"] {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const job = loadedCronStoreFromRows(
        loadCronRows(db, input.storeKey, new Set([input.jobId])),
        input.createdAtMsFallback,
      ).store.jobs[0];
      if (
        input.snapshot.expectedConfigRevision !== undefined &&
        (!job || resolveCronJobConfigRevision(job) !== input.snapshot.expectedConfigRevision)
      ) {
        throw new CronJobsStoreChangedError(input.storeKey);
      }
      const outcome = writeCronJobScratchInDatabase(db, input);
      return { outcome };
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.scratch.write" },
  );
}
