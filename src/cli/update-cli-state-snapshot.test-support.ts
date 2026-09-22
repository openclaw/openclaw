import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { releaseSnapshotTempDirectory } from "../infra/sqlite-readonly-location-cleanup.js";
import { prepareSqliteReadOnlyLocationSyncInProcess } from "../infra/sqlite-readonly-location.js";
import * as sqliteReadOnlyWorker from "../infra/sqlite-readonly-worker.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

const runHostReadOnlyWorker = sqliteReadOnlyWorker.runSqliteReadOnlyWorkerSync;

export function createUpdateStateProfileInitializer(
  fixtureRoot: string,
  fixtureStateDatabases: Set<string>,
): (env?: NodeJS.ProcessEnv) => void {
  const preparedStateDatabase = path.join(fixtureRoot, "prepared-state.sqlite");
  // Ordinary update cases model the existing schema advertised by their inspection fixture.
  return (env = process.env) => {
    const databasePath = resolveOpenClawStateSqlitePath(env);
    if (!fs.existsSync(databasePath) && fs.existsSync(preparedStateDatabase)) {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
      fs.copyFileSync(preparedStateDatabase, databasePath);
    }
    const database = openOpenClawStateDatabase({ env });
    fixtureStateDatabases.add(database.path);
    closeOpenClawStateDatabaseForTest();
    // Bootstrap once; every profile owns a separate writable copy of the closed database.
    if (!fs.existsSync(preparedStateDatabase)) {
      fs.copyFileSync(database.path, preparedStateDatabase);
    }
  };
}

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
