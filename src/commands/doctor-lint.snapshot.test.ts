import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  readMainDatabasePosixLocks,
  readSqliteShmPosixLocks,
} from "../infra/sqlite-posix-locks.test-support.js";
import { snapshotDoctorLintSqliteFamily } from "./doctor-lint.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.runIf(process.platform === "linux" || process.platform === "darwin")(
  "observes the complete SQLite family without releasing the live owner's locks",
  () => {
    const pathname = path.join(tempDirs.make("doctor-lint-observer-"), "state.sqlite");
    using database = new DatabaseSync(pathname);
    database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE writes (id INTEGER PRIMARY KEY);
      INSERT INTO writes DEFAULT VALUES;
    `);
    const mainLocks = readMainDatabasePosixLocks(pathname);
    const shmLocks = readSqliteShmPosixLocks(`${pathname}-shm`);
    expect(mainLocks).not.toEqual([]);
    expect(shmLocks).not.toEqual([]);

    const snapshot = snapshotDoctorLintSqliteFamily(pathname);

    expect(snapshot.map(({ path: file }) => file)).toEqual([
      pathname,
      `${pathname}-shm`,
      `${pathname}-wal`,
    ]);
    expect.soft(readMainDatabasePosixLocks(pathname)).toEqual(mainLocks);
    expect.soft(readSqliteShmPosixLocks(`${pathname}-shm`)).toEqual(shmLocks);
  },
);
