import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import * as sqliteCopy from "./sqlite-file-copy.js";
import {
  prepareSqliteReadOnlyCopyInProcess,
  prepareSqliteReadOnlyLocationInProcess,
  prepareSqliteReadOnlyLocationSyncInProcess,
} from "./sqlite-readonly-location.js";
import {
  isSqliteSnapshotCapacityError,
  SqliteSnapshotCapacityError,
} from "./sqlite-snapshot-capacity-error.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cleanup();
  });
});

function createTempDatabasePath(sql: string): string {
  const pathname = path.join(tempDirs.make("sqlite-capacity-source-"), "source.sqlite");
  using database = new (requireNodeSqlite().DatabaseSync)(pathname);
  database.exec(sql);
  return pathname;
}

it.each([
  ["synchronous copy", prepareSqliteReadOnlyLocationSyncInProcess],
  ["asynchronous copy", prepareSqliteReadOnlyCopyInProcess],
] as const)("refuses an undersized cache before an 8.4 GB %s", async (_mode, prepare) => {
  const databasePath = createTempDatabasePath("CREATE TABLE probe(value);");
  const stagingRoot = tempDirs.make("sqlite-snapshot-capacity-");
  const original = fs.readFileSync(databasePath);
  // Advertise the reported database size without allocating or reading gigabytes in this fixture.
  const stat = fs.statSync.bind(fs);
  vi.spyOn(fs, "statSync").mockImplementation((...args) => {
    const result = stat(...args);
    return String(args[0]) === databasePath && result && typeof result.size === "number"
      ? Object.assign(result, { size: 8_400_000_000 })
      : result;
  });
  const space = fs.statfsSync(stagingRoot);
  vi.spyOn(fs, "statfsSync").mockReturnValue(
    Object.assign(space, { bsize: 1, bavail: 1_000_000_000 }),
  );
  let prepared: Awaited<ReturnType<typeof prepare>> | undefined;
  try {
    const preparation = Promise.resolve()
      .then(() => prepare(databasePath, stagingRoot))
      .then((location) => (prepared = location));
    await expect(preparation).rejects.toThrow(
      /8400000000 bytes.*1000000000 bytes.*[Ff]ree disk space/s,
    );
    await expect(preparation).rejects.toBeInstanceOf(SqliteSnapshotCapacityError);
  } finally {
    await prepared?.cleanupAsync();
  }
  expect(fs.readFileSync(databasePath)).toEqual(original);
  expect(fs.readdirSync(stagingRoot)).toEqual([]);
});

it.each(["overwrite WAL", "WAL-only growth"] as const)(
  "budgets the logical image instead of retained %s frames",
  async (workload) => {
    const directory = tempDirs.make("sqlite-native-capacity-");
    const databasePath = path.join(directory, "source.sqlite");
    const targetPath = path.join(directory, "snapshot.sqlite");
    const stagingRoot = tempDirs.make("sqlite-native-capacity-staging-");
    const sqlite = requireNodeSqlite();
    using source = new sqlite.DatabaseSync(databasePath);
    source.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE payload(value BLOB NOT NULL);
    `);
    if (workload === "overwrite WAL") {
      source.exec("INSERT INTO payload VALUES(zeroblob(32768));");
    }
    source.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    if (workload === "WAL-only growth") {
      source.exec("INSERT INTO payload VALUES(zeroblob(32768));");
    }
    const update = source.prepare("UPDATE payload SET value = ?;");
    for (let generation = 1; generation <= 8; generation++) {
      update.run(Buffer.alloc(32768, generation));
    }

    const pageSize = Number(source.prepare("PRAGMA page_size;").get()?.page_size);
    const logicalBytes = Number(source.prepare("PRAGMA page_count;").get()?.page_count) * pageSize;
    const mainBytes = fs.statSync(databasePath).size;
    const familyBytes = mainBytes + fs.statSync(`${databasePath}-wal`).size;
    const availableBytes = 2 * logicalBytes;
    expect(familyBytes).toBeGreaterThan(availableBytes);
    if (workload === "WAL-only growth") {
      expect(mainBytes).toBeLessThan(logicalBytes - pageSize);
    }
    const space = fs.statfsSync(stagingRoot);
    const statfs = vi
      .spyOn(fs, "statfsSync")
      .mockReturnValue(Object.assign({}, space, { bsize: 1, bavail: logicalBytes - pageSize }));
    // A native image includes pages committed only to WAL, not just current main-file bytes.
    await expect(
      prepareSqliteReadOnlyLocationInProcess(databasePath, stagingRoot),
    ).rejects.toBeInstanceOf(SqliteSnapshotCapacityError);
    expect(fs.readdirSync(stagingRoot)).toEqual([]);

    statfs.mockReturnValue(Object.assign({}, space, { bsize: 1, bavail: availableBytes }));
    // A physical family copy still needs space for every retained WAL frame.
    await expect(
      prepareSqliteReadOnlyCopyInProcess(databasePath, stagingRoot),
    ).rejects.toBeInstanceOf(SqliteSnapshotCapacityError);
    expect(fs.readdirSync(stagingRoot)).toEqual([]);

    // The same volume has room for both the logical native image and its compacted output.
    await createVerifiedSqliteSnapshot({ sourcePath: databasePath, targetPath });
    using snapshot = new sqlite.DatabaseSync(targetPath, { readOnly: true });
    expect(
      snapshot
        .prepare("SELECT length(value) AS bytes, hex(substr(value, 1, 1)) AS marker FROM payload;")
        .get(),
    ).toEqual({ bytes: 32768, marker: "08" });
    expect(snapshot.prepare("PRAGMA integrity_check;").get()).toEqual({
      integrity_check: "ok",
    });
  },
);

it("keeps a failed copy blocking when snapshot cleanup also fails", async () => {
  const databasePath = createTempDatabasePath("CREATE TABLE probe(value);");
  const original = fs.readFileSync(databasePath);
  const stagingRoot = tempDirs.make("sqlite-capacity-cleanup-");
  const copyFailure = Object.assign(new Error("copy destination full"), { code: "ENOSPC" });
  const cleanupFailure = Object.assign(new Error("snapshot cleanup denied"), { code: "EACCES" });
  const copy = vi.spyOn(sqliteCopy, "copySqliteFile").mockRejectedValueOnce(copyFailure);
  const remove = fs.rmSync.bind(fs);
  let cleanupAttempted = false;
  vi.spyOn(fs, "rmSync").mockImplementation((directory, options) => {
    if (path.dirname(String(directory)) === stagingRoot) {
      cleanupAttempted = true;
      throw cleanupFailure;
    }
    remove(directory, options);
  });

  const error = await prepareSqliteReadOnlyCopyInProcess(databasePath, stagingRoot).catch(
    (cause: unknown) => cause,
  );
  expect(copy).toHaveBeenCalledTimes(1);
  expect(cleanupAttempted).toBe(true);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error).toMatchObject({ errors: expect.arrayContaining([cleanupFailure]) });
  expect(isSqliteSnapshotCapacityError(error)).toBe(false);
  expect(error instanceof Error && isSqliteSnapshotCapacityError(error.cause)).toBe(true);
  expect(fs.readFileSync(databasePath)).toEqual(original);
});
