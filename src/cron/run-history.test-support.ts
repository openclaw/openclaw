import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { projectCronRunHistoryPage, type ReadCronRunHistoryPageOptions } from "./run-history.js";
import { readCronRunRecordsInDatabase } from "./store/run-history.kernel.js";

/** Tests inspect their isolated database, never restore a process-wide Tasks registry. */
function readCronRunRecordsForTests(jobId?: string) {
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) =>
      readCronRunRecordsInDatabase(db, jobId),
    ) ?? []
  );
}
export function readCronRunHistoryPageForTests(options: ReadCronRunHistoryPageOptions) {
  return projectCronRunHistoryPage(readCronRunRecordsForTests(options.jobId), options);
}
