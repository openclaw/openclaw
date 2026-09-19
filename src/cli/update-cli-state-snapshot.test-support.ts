import path from "node:path";
import { vi } from "vitest";
import { releaseSnapshotTempDirectory } from "../infra/sqlite-readonly-location-cleanup.js";
import { prepareSqliteReadOnlyLocationSyncInProcess } from "../infra/sqlite-readonly-location.js";
import * as sqliteReadOnlyWorker from "../infra/sqlite-readonly-worker.js";

const runHostReadOnlyWorker = sqliteReadOnlyWorker.runSqliteReadOnlyWorkerSync;

export function mockUpdateStateSnapshotWorker(fixtureStateDatabases: ReadonlySet<string>): void {
  // Keep real staging/adoption for fixture-owned stores; process-boundary tests
  // cover cold ledgers and competing writers.
  vi.spyOn(sqliteReadOnlyWorker, "runSqliteReadOnlyWorkerSync").mockImplementation(
    (pathname, stagingRoot) => {
      if (!fixtureStateDatabases.has(path.resolve(pathname))) {
        return runHostReadOnlyWorker(pathname, stagingRoot);
      }
      const prepared = prepareSqliteReadOnlyLocationSyncInProcess(pathname, stagingRoot);
      releaseSnapshotTempDirectory(prepared.cleanupRoot ?? path.dirname(prepared.location));
      return prepared.location;
    },
  );
}
