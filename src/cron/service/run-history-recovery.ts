import type { DatabaseSync } from "node:sqlite";
import {
  cronRunRecordStoreKey,
  cronRunRecordToRunLogEntry,
  cronRunRecordToScriptRunResult,
  cronRunRecordToTriggerEval,
  resolveCronRunRecordTimestamp,
} from "../run-history-detail.js";
import { createCronExecutionId } from "../run-id.js";
import type { CronRunLogEntry } from "../run-log-types.js";
import { readCronRunRecordsInDatabase } from "../store/run-history.kernel.js";
import type { CronRunRecord, CronJsonValue as JsonValue } from "../store/run-history.types.js";
import type { CronRunStatus } from "../types.js";

function receiptIdFromCronRunId(
  taskRunId: string | undefined,
  jobId: string,
  startedAt: number,
): string | undefined {
  const prefix = `${createCronExecutionId(jobId, startedAt)}:`;
  if (!taskRunId?.startsWith(prefix)) {
    return undefined;
  }
  // Receipt-backed IDs use the first discriminator; optional public IDs follow
  // it. Legacy public/random discriminators must still match a real receipt row.
  return taskRunId.slice(prefix.length).split(":", 1)[0] || undefined;
}

function findLatestCronRunForRecovery(
  records: readonly CronRunRecord[],
  jobId: string,
  startedAt: number,
  storeKey: string,
  receiptId?: string,
): CronRunRecord | undefined {
  const executionRunId = createCronExecutionId(jobId, startedAt);
  const prefix = `${executionRunId}:`;
  const receiptRunId = receiptId ? `${prefix}${receiptId}` : undefined;
  return records
    .filter((record) => {
      if (record.jobId !== jobId) {
        return false;
      }
      const taskStoreKey = cronRunRecordStoreKey(record);
      if (receiptRunId) {
        // Receipt recovery accepts only its owner-native identity; legacy rows
        // without that receipt prefix are ambiguous when runs share a millisecond.
        return (
          taskStoreKey === storeKey &&
          (record.runId === receiptRunId || record.runId?.startsWith(`${receiptRunId}:`))
        );
      }
      if (taskStoreKey === undefined) {
        // Exact match covers detail-less pre-discriminator rows from older releases.
        return record.runId === executionRunId;
      }
      // A matching timestamp cannot authorize adopting an unrelated record row.
      return (
        taskStoreKey === storeKey &&
        (record.runId === executionRunId || record.runId?.startsWith(prefix))
      );
    })
    .toSorted(
      (left, right) =>
        Number(left.endedAt !== undefined) - Number(right.endedAt !== undefined) ||
        resolveCronRunRecordTimestamp(right) - resolveCronRunRecordTimestamp(left) ||
        right.createdAt - left.createdAt ||
        right.id.localeCompare(left.id),
    )[0];
}

type FinalizedCronRun = {
  entry: CronRunLogEntry & { status: CronRunStatus };
  scriptResult?: { scriptStateChanged: true; scriptState?: JsonValue };
  triggerEval?: { fired: boolean; stateChanged: boolean; state?: JsonValue };
};

function finalizedCronRun(
  record: CronRunRecord | undefined,
  jobId: string,
): FinalizedCronRun | undefined {
  if (!record || record.jobId !== jobId || record.endedAt === undefined) {
    return undefined;
  }
  const triggerEval = cronRunRecordToTriggerEval(record);
  const storedEntry = cronRunRecordToRunLogEntry(record);
  const entry =
    storedEntry ??
    (record.status === "succeeded" && triggerEval?.fired === false
      ? {
          ts: record.endedAt,
          jobId,
          action: "finished" as const,
          status: "ok" as const,
          ...(record.startedAt === undefined
            ? {}
            : {
                runAtMs: record.startedAt,
                durationMs: Math.max(0, record.endedAt - record.startedAt),
              }),
        }
      : undefined);
  if (!entry?.status) {
    return undefined;
  }
  const scriptResult = cronRunRecordToScriptRunResult(record);
  return {
    entry: { ...entry, status: entry.status },
    ...(scriptResult ? { scriptResult } : {}),
    ...(triggerEval ? { triggerEval } : {}),
  };
}

/** Re-reads record recovery facts on the caller's exact SQLite transaction. */
export function findCronRunRecoveryInDatabase(params: {
  database: DatabaseSync;
  jobId: string;
  startedAt: number;
  storeKey: string;
  receiptId?: string;
}): { taskRunId?: string; receiptId?: string; finalized?: FinalizedCronRun } {
  const record = findLatestCronRunForRecovery(
    readCronRunRecordsInDatabase(params.database, params.jobId),
    params.jobId,
    params.startedAt,
    params.storeKey,
    params.receiptId,
  );
  const finalized = finalizedCronRun(record, params.jobId);
  const runId =
    record?.runId ??
    (params.receiptId
      ? `${createCronExecutionId(params.jobId, params.startedAt)}:${params.receiptId}`
      : undefined);
  const receiptId = receiptIdFromCronRunId(runId, params.jobId, params.startedAt);
  return {
    ...(runId ? { taskRunId: runId } : {}),
    ...(receiptId ? { receiptId } : {}),
    ...(finalized ? { finalized } : {}),
  };
}
