import { createHash } from "node:crypto";
import { isRecord, isStringRecord } from "@openclaw/normalization-core/record-coerce";
import { inspectCronRowsForDoctor } from "../../commands/doctor/cron/store-inventory.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { runSqliteReadOnlyWorkerSync } from "../../infra/sqlite-readonly-worker.js";
import { serveWorkerTasks } from "../../infra/worker-task-server.js";
import {
  assertStateReadSchema,
  openOpenClawStateReadConnection,
} from "../../state/openclaw-state-db-read-connection.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { cronRunRecordToRunLogEntry } from "../run-history-detail.js";
import { serializeCronLoadError } from "./load-error.js";
import { loadCronStoreFromDatabase } from "./load.kernel.js";
import type {
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
          (input.history.query !== undefined && typeof input.history.query !== "string") ||
          (input.history.taskIds !== undefined &&
            (!Array.isArray(input.history.taskIds) ||
              input.history.taskIds.length > 200 ||
              input.history.taskIds.some((id) => typeof id !== "string"))) ||
          (input.history.view !== undefined &&
            input.history.view !== "full" &&
            input.history.view !== "summary") ||
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
    const jobNameById = input.history?.jobNameById;
    if (jobNameById !== undefined && !isStringRecord(jobNameById)) {
      throw new Error("Cron read-only worker requires string history job names");
    }
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
        if (isRecord(input.history) && typeof storeKey === "string") {
          // History consumes the canonical released table only after read admission.
          assertStateReadSchema(db, location);
          if (Array.isArray(input.history.taskIds)) {
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
            typeof input.history.jobId === "string" ? input.history.jobId : undefined,
            typeof input.history.query === "string" ? input.history.query : undefined,
            jobNameById,
          );
          if (isRecord(input.history.transcript) && typeof storeKey === "string") {
            return {
              ok: true,
              binding: selectTranscriptBinding(candidates.records, storeKey, {
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
