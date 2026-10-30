import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
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
export function findCronRunForTests(runId: string) {
  return readCronRunRecordsForTests().find((row) => row.runId === runId);
}
export function readCronRunHistoryPageForTests(options: ReadCronRunHistoryPageOptions) {
  return projectCronRunHistoryPage(readCronRunRecordsForTests(options.jobId), options);
}
