import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { sha256File } from "../infra/crypto-digest.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { SqliteSnapshotCleanupError } from "../infra/sqlite-readonly-location-cleanup.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { BLOAT_MIN_FILE_BYTES } from "./doctor-db-bloat.constants.js";
import { readSqliteDatabaseBloat } from "./doctor-db-bloat.read.js";

vi.mock("../state/openclaw-agent-db-registry-listing.js", () => ({
  readRegisteredAgentDatabases: () => [],
}));

afterEach(() => vi.restoreAllMocks());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createSizedFile(size: number): string {
  const pathname = path.join(tempDirs.make("doctor-bloat-read-"), "database.sqlite");
  fs.writeFileSync(pathname, "");
  fs.truncateSync(pathname, size);
  return pathname;
}

it.each([
  { size: BLOAT_MIN_FILE_BYTES - 1, preparations: 0 },
  { size: BLOAT_MIN_FILE_BYTES, preparations: 1 },
])(
  "prepares $preparations snapshots at the $size-byte reporting boundary",
  ({ size, preparations }) => {
    const pathname = createSizedFile(size);
    const prepare = vi
      .spyOn(snapshots, "prepareSqliteReadOnlyLocationSync")
      .mockImplementation(() => {
        throw new Error("controlled preparation failure");
      });
    expect(readSqliteDatabaseBloat({ path: pathname, env: {} })).toEqual([]);
    expect(prepare).toHaveBeenCalledTimes(preparations);
  },
);

it("skips a small main file with a large live WAL without changing source artifacts", async () => {
  const pathname = path.join(tempDirs.make("doctor-bloat-wal-"), "database.sqlite");
  const database = openNodeSqliteDatabase(pathname);
  try {
    database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE payload(value BLOB)",
    );
    database.prepare("INSERT INTO payload VALUES (zeroblob(?))").run(BLOAT_MIN_FILE_BYTES);
    expect(fs.statSync(pathname).size).toBeLessThan(BLOAT_MIN_FILE_BYTES);
    expect(fs.statSync(`${pathname}-wal`).size).toBeGreaterThan(BLOAT_MIN_FILE_BYTES);
    const family = [pathname, `${pathname}-wal`, `${pathname}-shm`];
    const before = await Promise.all(family.map((member) => sha256File(member)));
    const prepare = vi
      .spyOn(snapshots, "prepareSqliteReadOnlyLocationSync")
      .mockImplementation(() => {
        throw new Error("unexpected snapshot preparation");
      });

    expect(readSqliteDatabaseBloat({ path: pathname, env: {} })).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
    expect(await Promise.all(family.map((member) => sha256File(member)))).toEqual(before);
  } finally {
    database.close();
  }
});

it.each([
  { error: new Error("unavailable read"), cleanup: false },
  { error: new SqliteSnapshotCleanupError("incomplete cleanup"), cleanup: true },
])("preserves cleanup failure=$cleanup without opening SQLite", ({ error, cleanup }) => {
  const prepare = vi
    .spyOn(snapshots, "prepareSqliteReadOnlyLocationSync")
    .mockImplementation(() => {
      throw error;
    });
  // The reporting-size file reaches preparation; the controlled failure prevents a database open.
  const pathname = createSizedFile(BLOAT_MIN_FILE_BYTES);
  const read = () => readSqliteDatabaseBloat({ path: pathname, env: {} });
  if (cleanup) {
    expect(read).toThrow(error);
  } else {
    expect(read()).toEqual([]);
  }
  expect(prepare).toHaveBeenCalledOnce();
});
