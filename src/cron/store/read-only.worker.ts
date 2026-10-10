import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { inspectCronRowsForDoctor } from "../../commands/doctor/cron/store-inventory.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { runSqliteReadOnlyWorkerSync } from "../../infra/sqlite-readonly-worker.js";
import { serveWorkerTasks } from "../../infra/worker-task-server.js";
import {
  assertStateReadSchema,
  openOpenClawStateReadConnection,
} from "../../state/openclaw-state-db-read-connection.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { cronRunRecordStoreKey, cronRunRecordToRunLogEntry } from "../run-history-detail.js";
import { serializeCronLoadError } from "./load-error.js";
import { loadCronStoreFromDatabase } from "./load.kernel.js";
import type {
  CronReadOnlyResult,
  CronRunHistoryBinding,
  CronRunHistorySelector,
} from "./read-only.types.js";
import { readCronRunRecordsInDatabase } from "./run-history.kernel.js";
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
          (input.history.jobId !== undefined && typeof input.history.jobId !== "string") ||
          (input.history.transcript !== undefined &&
            (typeof input.history.jobId !== "string" ||
              !isRecord(input.history.transcript) ||
              (input.history.transcript.runId !== undefined &&
                typeof input.history.transcript.runId !== "string") ||
              (input.history.transcript.runAtMs !== undefined &&
                typeof input.history.transcript.runAtMs !== "number")))))
    ) {
      throw new Error(
        "Cron read-only worker requires a database location and an optional store key",
      );
    }
    const { location, storeKey, stagingRoot } = input;
    return await control.runNativeSection(() => {
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
          const history = readCronRunRecordsInDatabase(
            db,
            typeof input.history.jobId === "string" ? input.history.jobId : undefined,
          ).filter((row) => cronRunRecordStoreKey(row) === storeKey);
          if (isRecord(input.history.transcript) && typeof storeKey === "string") {
            return {
              ok: true,
              binding: selectTranscriptBinding(history, storeKey, {
                runId:
                  typeof input.history.transcript.runId === "string"
                    ? input.history.transcript.runId
                    : undefined,
                runAtMs:
                  typeof input.history.transcript.runAtMs === "number"
                    ? input.history.transcript.runAtMs
                    : undefined,
              }),
            } satisfies CronReadOnlyResult;
          }
          return {
            ok: true,
            history,
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
