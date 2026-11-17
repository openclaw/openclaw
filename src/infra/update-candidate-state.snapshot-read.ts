import fs from "node:fs/promises";
import { withPreparedSqliteSnapshot } from "./sqlite-readonly-location-cleanup.js";
import {
  prepareSqliteReadOnlyLocationInProcess,
  prepareSqliteReadOnlyLocationSyncInProcess,
} from "./sqlite-readonly-location.js";
import {
  createUpdateStateSnapshotReporter,
  type UpdateStateInspectionProgress,
} from "./update-candidate-state.diagnostics.js";

/** Read a private read-only copy of one state database; cleanup never replaces the result. */
export async function withStateDatabaseSnapshot<T>(
  file: string,
  read: (location: string) => T | Promise<T>,
  stagingRoot?: string,
  onProgress?: (progress: UpdateStateInspectionProgress) => void,
  preserveSourceArtifacts = false,
): Promise<T> {
  const progress = createUpdateStateSnapshotReporter(file, "shared database snapshot", onProgress);
  const snapshot = preserveSourceArtifacts
    ? prepareSqliteReadOnlyLocationSyncInProcess(file, stagingRoot)
    : await prepareSqliteReadOnlyLocationInProcess(
        file,
        stagingRoot,
        undefined,
        progress.onProgress,
      );
  // Temporary cleanup cannot replace a candidate result or its original read failure.
  return withPreparedSqliteSnapshot(
    snapshot,
    async (location) => {
      progress.complete((await fs.stat(location)).size);
      return read(location);
    },
    { cleanupFailure: "warn" },
  );
}
