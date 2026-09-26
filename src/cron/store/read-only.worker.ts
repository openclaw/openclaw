import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { runSqliteReadOnlyWorkerSync } from "../../infra/sqlite-readonly-worker.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "../../infra/state-database-coordinator.js";
import { serveWorkerTasks } from "../../infra/worker-task-server.js";
import {
  assertStateReadSchema,
  openOpenClawStateReadConnection,
} from "../../state/openclaw-state-db-read-connection.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { cronRunRecordStoreKey } from "../run-history-detail.js";
import { inspectCronRowsForDoctor } from "./doctor-inventory.js";
import { serializeCronLoadError } from "./load-error.js";
import { loadCronStoreFromDatabase } from "./load.kernel.js";
import type { CronReadOnlyResult } from "./read-only.types.js";
import { readCronRunRecordsInDatabase } from "./run-history.kernel.js";

serveWorkerTasks(async (input, _channel, control): Promise<CronReadOnlyResult> => {
  try {
    if (
      !isRecord(input) ||
      typeof input.location !== "string" ||
      (input.storeKey !== undefined && typeof input.storeKey !== "string") ||
      (input.stagingRoot !== undefined && typeof input.stagingRoot !== "string") ||
      (input.history !== undefined &&
        (typeof input.storeKey !== "string" ||
          !isRecord(input.history) ||
          (input.history.jobId !== undefined && typeof input.history.jobId !== "string"))) ||
      !isRecord(input.coordinatorRuntime) ||
      typeof input.coordinatorRuntime.directory !== "string" ||
      typeof input.coordinatorRuntime.keepAlive !== "boolean"
    ) {
      throw new Error(
        "Cron read-only worker requires a database location and an optional store key",
      );
    }
    const { location, storeKey, stagingRoot } = input;
    const runtime = {
      directory: input.coordinatorRuntime.directory,
      keepAlive: input.coordinatorRuntime.keepAlive,
    };
    return await control.runNativeSection(() =>
      withStateDatabaseCoordinatorRuntimeDirectory(runtime, () => {
        // Copying stays in a separate process; the parent owns every unpublished child artifact.
        const connection = stagingRoot
          ? openOpenClawStateReadConnection(
              location,
              runSqliteReadOnlyWorkerSync(location, stagingRoot),
              undefined,
              stagingRoot,
            )
          : undefined;
        // The connection owner retains failed-close token custody without imposing a schema gate.
        const db = connection?.database.db ?? openNodeSqliteDatabase(location, { readOnly: true });
        try {
          if (isRecord(input.history)) {
            // History consumes the canonical released table only after read admission.
            assertStateReadSchema(db, location);
            return {
              ok: true,
              history: readCronRunRecordsInDatabase(
                db,
                typeof input.history.jobId === "string" ? input.history.jobId : undefined,
              ).filter((row) => cronRunRecordStoreKey(row) === storeKey),
            } satisfies CronReadOnlyResult;
          }
          return {
            ok: true,
            inventory: storeKey === undefined ? inspectCronRowsForDoctor(db) : undefined,
            loaded:
              storeKey !== undefined && tableExists(db, "cron_jobs")
                ? loadCronStoreFromDatabase(db, storeKey)
                : undefined,
          } satisfies CronReadOnlyResult;
        } finally {
          if (connection) {
            connection.close();
          } else {
            db.close();
          }
        }
      }),
    );
  } catch (error) {
    return { ok: false, error: serializeCronLoadError(error) };
  }
});
