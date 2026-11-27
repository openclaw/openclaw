import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { cronRunRecordToRunLogEntry } from "./run-history-detail.js";
import { projectCronRunHistoryPage, type ReadCronRunHistoryPageOptions } from "./run-history.js";
import { readCronRunRecordsInDatabase } from "./store/run-history.kernel.js";

/** Tests inspect their isolated database, never restore a process-wide Tasks registry. */
export function readCronRunRecordsForTests(jobId?: string) {
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) =>
      readCronRunRecordsInDatabase(db, jobId),
    ) ?? []
  );
}
export function readCronRunStateForTests(jobId: string) {
  const record = readCronRunRecordsForTests(jobId).at(-1);
  const entry = record ? cronRunRecordToRunLogEntry(record) : null;
  if (!entry) {
    return undefined;
  }
  return {
    lastRunAtMs: entry.runAtMs,
    lastRunStatus: entry.status,
    lastStatus: entry.status,
    lastDurationMs: entry.durationMs,
    lastError: entry.error,
    lastErrorReason: entry.errorReason,
    lastDelivered: entry.delivered,
    lastDeliveryStatus: entry.deliveryStatus,
    lastDeliveryError: entry.deliveryError,
    deliverySuppressionReason: entry.deliverySuppressionReason,
    nextRunAtMs: entry.nextRunAtMs,
  };
}
export function findCronRunForTests(runId: string) {
  return readCronRunRecordsForTests().find((row) => row.runId === runId);
}
export function readCronRunHistoryPageForTests(options: ReadCronRunHistoryPageOptions) {
  return projectCronRunHistoryPage(readCronRunRecordsForTests(options.jobId), options);
}
