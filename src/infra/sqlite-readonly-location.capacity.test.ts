import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { encodeOpenClawStateWorkerError } from "../state/openclaw-state-worker-error.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { markSqliteInspectionOperation } from "./sqlite-error-diagnostics.js";
import * as sqliteCopy from "./sqlite-file-copy.js";
import { SqliteSnapshotCleanupError } from "./sqlite-readonly-location-cleanup.js";
import {
  prepareSqliteReadOnlyCopyInProcess,
  prepareSqliteReadOnlyLocationInProcess,
  prepareSqliteReadOnlyLocationSyncInProcess,
} from "./sqlite-readonly-location.js";
import {
  isSqliteSnapshotCapacityError,
  SqliteSnapshotCapacityError,
} from "./sqlite-snapshot-capacity-error.js";
import { decodeSqliteSnapshotStagingError } from "./sqlite-snapshot-staging-error.js";
import { sqliteSnapshotStagingError } from "./sqlite-snapshot-staging.js";

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
  ["online backup", prepareSqliteReadOnlyLocationInProcess],
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

it.each([
  { allocation: "cache root", code: "ENOSPC", capacity: true },
  { allocation: "namespace", code: "EDQUOT", capacity: true },
  { allocation: "namespace", code: "EACCES", capacity: false },
])(
  "preserves the source after $allocation creation fails with $code",
  async ({ allocation, code, capacity }) => {
    const databasePath = createTempDatabasePath("CREATE TABLE probe(value);");
    const original = fs.readFileSync(databasePath);
    const cacheRoot = path.join(tempDirs.make("sqlite-capacity-cache-"), "missing");
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "0");
    vi.stubEnv("XDG_CACHE_HOME", cacheRoot);
    const failure = Object.assign(new Error(`root allocation ${code}`), { code });
    const mkdir = fs.mkdirSync.bind(fs);
    let injected = false;
    vi.spyOn(fs, "mkdirSync").mockImplementation((directory, options) => {
      const target = String(directory);
      if (
        allocation === "cache root"
          ? target === cacheRoot
          : path.dirname(target) === path.join(cacheRoot, "openclaw") &&
            path.basename(target).startsWith("sqlite-")
      ) {
        injected = true;
        throw failure;
      }
      return mkdir(directory, options);
    });

    const error = await prepareSqliteReadOnlyCopyInProcess(databasePath).catch(
      (cause: unknown) => cause,
    );
    expect(injected).toBe(true);
    expect(isSqliteSnapshotCapacityError(error)).toBe(capacity);
    expect(capacity && error instanceof Error ? error.cause : error).toBe(failure);
    expect(fs.readFileSync(databasePath)).toEqual(original);
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

const fullDisk = () => Object.assign(new Error("destination full"), { code: "ENOSPC" });
it.each([
  { name: "destination space", error: fullDisk(), capacity: true },
  {
    name: "destination quota",
    error: Object.assign(new Error("quota"), { code: "EDQUOT" }),
    capacity: true,
  },
  { name: "SQLite FULL", error: Object.assign(new Error("full"), { errcode: 13 }), capacity: true },
  {
    name: "source open",
    error: markSqliteInspectionOperation(fullDisk(), "source"),
    capacity: false,
  },
  {
    name: "corruption",
    error: Object.assign(new Error("corrupt"), { errcode: 11 }),
    capacity: false,
  },
  { name: "I/O", error: Object.assign(new Error("I/O"), { code: "EIO" }), capacity: false },
  {
    name: "cleanup",
    error: new SqliteSnapshotCleanupError("cleanup failed", { cause: fullDisk() }),
    capacity: false,
  },
  {
    name: "aggregate",
    error: new AggregateError([fullDisk()], "cleanup failed", { cause: fullDisk() }),
    capacity: false,
  },
  {
    name: "wrapped cleanup",
    error: new Error("preparation failed", {
      cause: new SqliteSnapshotCleanupError("cleanup failed", { cause: fullDisk() }),
    }),
    capacity: false,
  },
])("preserves the $name outcome through staging error hydration", ({ error, capacity }) => {
  const failure = sqliteSnapshotStagingError("/synthetic/private-snapshot", error);
  expect(isSqliteSnapshotCapacityError(failure)).toBe(capacity);
  const hydrated = decodeSqliteSnapshotStagingError(
    encodeOpenClawStateWorkerError(failure, { includeOrdinary: true }),
  );
  expect(isSqliteSnapshotCapacityError(hydrated)).toBe(capacity);
});
