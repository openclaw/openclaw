import { createHash } from "node:crypto";
import {
  inspectCronOwnerRowsForDoctor,
  inspectCronRowsForDoctor,
} from "../../commands/doctor/cron/store-inventory.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { runSqliteReadOnlyWorkerSync } from "../../infra/sqlite-readonly-worker.js";
import { serveWorkerTasks } from "../../infra/worker-task-server.js";
import { isStatePostgres } from "../../state/openclaw-state-db-engine.js";
import {
  assertStateReadSchema,
  openOpenClawStateReadConnection,
} from "../../state/openclaw-state-db-read-connection.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { cronRunRecordToRunLogEntry } from "../run-history-detail.js";
import { serializeCronLoadError } from "./load-error.js";
import { loadCronStoreFromDatabase } from "./load.kernel.js";
import type {
  CronReadOnlyRequest,
  CronReadOnlyResult,
  CronRunHistoryBinding,
  CronRunHistorySelector,
} from "./read-only.types.js";
import {
  readCronRunHistoryCandidatesInDatabase,
  readCronRunHistoryRecordsInDatabase,
} from "./run-history-read.worker.js";
import type { CronRunRecord } from "./run-history.types.js";

function selectTranscriptBinding(
  records: CronRunRecord[],
  storeKey: string,
  selector: CronRunHistorySelector,
): CronRunHistoryBinding | undefined {
  let selected:
    | { record: CronRunRecord; entry: NonNullable<ReturnType<typeof cronRunRecordToRunLogEntry>> }
    | undefined;
  for (const record of records) {
    const entry = cronRunRecordToRunLogEntry(record);
    if (
      !entry ||
      (selector.runId && entry.runId !== selector.runId) ||
      (selector.runAtMs !== undefined && entry.runAtMs !== selector.runAtMs)
    ) {
      continue;
    }
    // A matching row without transcript identity still makes the selector ambiguous.
    if (selected) {
      return undefined;
    }
    selected = { record, entry };
  }
  if (!selected) {
    return undefined;
  }
  const { record, entry } = selected;
  if (!entry.sessionKey || !entry.sessionId) {
    return undefined;
  }
  return {
    // Keep cursor identity bytes stable, including both internal and public run IDs.
    binding: createHash("sha256")
      .update(
        JSON.stringify([
          storeKey,
          record.id,
          record.runId,
          entry.jobId,
          entry.runId,
          entry.runAtMs,
          entry.sessionKey,
          entry.sessionId,
          record.agentId,
        ]),
      )
      .digest("base64url"),
    sessionKey: entry.sessionKey,
    sessionId: entry.sessionId,
    agentId: record.agentId,
  };
}

serveWorkerTasks<CronReadOnlyResult, CronReadOnlyRequest>(async (input, _channel, control) => {
  try {
    if (input.history?.taskIds && input.history.taskIds.length > 200) {
      throw new Error(
        "Cron read-only worker requires a database location and an optional store key",
      );
    }
    const { location, storeKey, stagingRoot } = input;
    const jobNameById = input.history?.jobNameById;
    return await control.runNativeSection(() => {
      // Copying stays in a separate process; the parent owns every unpublished child artifact.
      const connection = isStatePostgres()
        ? openOpenClawStateReadConnection(location, location)
        : stagingRoot
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
        if (input.inspect) {
          assertStateReadSchema(db, location);
          return {
            ok: true,
            owners:
              input.inspect === "owners" && storeKey !== undefined
                ? inspectCronOwnerRowsForDoctor(db, storeKey)
                : undefined,
          } satisfies CronReadOnlyResult;
        }
        if (input.history && storeKey !== undefined) {
          // History consumes the canonical released table only after read admission.
          assertStateReadSchema(db, location);
          if (input.history.taskIds) {
            return {
              ok: true,
              history: readCronRunHistoryRecordsInDatabase(
                db,
                storeKey,
                input.history.taskIds,
                input.history.view === "summary" ? "summary" : "full",
              ),
            } satisfies CronReadOnlyResult;
          }
          const candidates = readCronRunHistoryCandidatesInDatabase(
            db,
            storeKey,
            input.history.jobId,
            input.history.query,
            jobNameById,
          );
          if (input.history.transcript) {
            return {
              ok: true,
              binding: selectTranscriptBinding(
                candidates.records,
                storeKey,
                input.history.transcript,
              ),
            } satisfies CronReadOnlyResult;
          }
          return {
            ok: true,
            candidates,
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
    });
  } catch (error) {
    return { ok: false, error: serializeCronLoadError(error) };
  }
});
