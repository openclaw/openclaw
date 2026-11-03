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
vi.mock("../state/openclaw-state-db-readonly.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/openclaw-state-db-readonly.js")>();
  return {
    ...actual,
    // This file isolates size admission; the real registry snapshot runs in the worker test.
    withOpenClawStateDatabaseReadSnapshot: async (operation: () => Promise<unknown>) => operation(),
  };
});

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
  async ({ size, preparations }) => {
    const pathname = createSizedFile(size);
    const prepare = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation(() => {
      throw new Error("controlled preparation failure");
    });
    expect(await readSqliteDatabaseBloat({ path: pathname, env: {} })).toEqual([]);
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
    const prepare = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation(() => {
      throw new Error("unexpected snapshot preparation");
    });

    expect(await readSqliteDatabaseBloat({ path: pathname, env: {} })).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
    expect(await Promise.all(family.map((member) => sha256File(member)))).toEqual(before);
  } finally {
    database.close();
  }
});

it.each([
  { error: new Error("unavailable read"), cleanup: false },
  { error: new SqliteSnapshotCleanupError("incomplete cleanup"), cleanup: true },
])("preserves cleanup failure=$cleanup without opening SQLite", async ({ error, cleanup }) => {
  const prepare = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation(() => {
    throw error;
  });
  // The reporting-size file reaches preparation; the controlled failure prevents a database open.
  const pathname = createSizedFile(BLOAT_MIN_FILE_BYTES);
  const read = () => readSqliteDatabaseBloat({ path: pathname, env: {} });
  if (cleanup) {
    await expect(read()).rejects.toThrow(error);
  } else {
    expect(await read()).toEqual([]);
  }
  expect(prepare).toHaveBeenCalledOnce();
});

it("cancels database-size preparation instead of swallowing the aborted inspection", async () => {
  const controller = new AbortController();
  const reason = new Error("Doctor inspection cancelled");
  vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation(() => {
    controller.abort(reason);
    throw reason;
  });
  const pathname = createSizedFile(BLOAT_MIN_FILE_BYTES);
  await expect(
    readSqliteDatabaseBloat({ path: pathname, env: {}, signal: controller.signal }),
  ).rejects.toThrow(reason);
});

function createPaddedDatabase(params: {
  label: string;
  pageSize: number;
  autoVacuum?: number;
  wal?: boolean;
}): string {
  const pathname = path.join(tempDirs.make(params.label), "database.sqlite");
  const database = openNodeSqliteDatabase(pathname);
  try {
    database.exec(
      `PRAGMA page_size=${params.pageSize}; PRAGMA auto_vacuum=${params.autoVacuum ?? 0}`,
    );
    if (params.wal) {
      database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    }
    database.exec("CREATE TABLE payload(value)");
    const insert = database.prepare("INSERT INTO payload VALUES (?)");
    for (let index = 0; index < 300; index += 1) {
      insert.run("x".repeat(2000));
    }
    database.exec("DELETE FROM payload WHERE rowid < 290");
  } finally {
    database.close();
  }
  // Reporting-size files reach the header reader, so pad past the boundary without
  // touching the header page the reader validates.
  fs.truncateSync(pathname, BLOAT_MIN_FILE_BYTES);
  return pathname;
}

it("answers reporting-size files from the header without preparing a snapshot", async () => {
  const pathname = createPaddedDatabase({ label: "doctor-bloat-header-", pageSize: 4096 });
  const prepare = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation(() => {
    throw new Error("unexpected snapshot preparation");
  });
  const results = await readSqliteDatabaseBloat({ path: pathname, env: {} });
  expect(results).toHaveLength(1);
  expect(results[0].stats.fileBytes).toBe(BLOAT_MIN_FILE_BYTES);
  expect(results[0].stats.freeBytes).toBeGreaterThan(0);
  expect(results[0].stats.incrementalAutoVacuum).toBe(false);
  expect(prepare).not.toHaveBeenCalled();
});

it("decodes a stored page-size value of 1 as 65536 from the header", async () => {
  const pathname = createPaddedDatabase({ label: "doctor-bloat-header-big-", pageSize: 65536 });
  const prepare = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation(() => {
    throw new Error("unexpected snapshot preparation");
  });
  const results = await readSqliteDatabaseBloat({ path: pathname, env: {} });
  expect(results).toHaveLength(1);
  expect(prepare).not.toHaveBeenCalled();
});

it.each([
  { autoVacuum: 0, incremental: false },
  { autoVacuum: 1, incremental: false },
  { autoVacuum: 2, incremental: true },
])("decodes auto_vacuum=$autoVacuum mode from the header", async ({ autoVacuum, incremental }) => {
  const pathname = createPaddedDatabase({
    label: "doctor-bloat-header-av-",
    pageSize: 4096,
    autoVacuum,
  });
  const results = await readSqliteDatabaseBloat({ path: pathname, env: {} });
  expect(results).toHaveLength(1);
  expect(results[0].stats.incrementalAutoVacuum).toBe(incremental);
});

it("answers a WAL-mode reporting-size file from the header without changing source artifacts", async () => {
  const pathname = createPaddedDatabase({
    label: "doctor-bloat-header-wal-",
    pageSize: 4096,
    wal: true,
  });
  const family = [pathname, `${pathname}-wal`, `${pathname}-shm`].filter((member) =>
    fs.existsSync(member),
  );
  const before = await Promise.all(family.map((member) => sha256File(member)));
  const results = await readSqliteDatabaseBloat({ path: pathname, env: {} });
  expect(results).toHaveLength(1);
  expect(results[0].stats.freeBytes).toBeGreaterThan(0);
  expect(await Promise.all(family.map((member) => sha256File(member)))).toEqual(before);
});

it("falls back to snapshot preparation when the header magic does not validate", async () => {
  const pathname = path.join(tempDirs.make("doctor-bloat-header-garbage-"), "database.sqlite");
  fs.writeFileSync(pathname, Buffer.alloc(BLOAT_MIN_FILE_BYTES, 0x41));
  const prepare = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation(() => {
    throw new Error("controlled preparation failure");
  });
  expect(await readSqliteDatabaseBloat({ path: pathname, env: {} })).toEqual([]);
  expect(prepare).toHaveBeenCalledOnce();
});
