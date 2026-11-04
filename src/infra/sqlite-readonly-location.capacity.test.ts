import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { encodeOpenClawStateWorkerError } from "../state/openclaw-state-worker-error.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { markSqliteInspectionOperation } from "./sqlite-error-diagnostics.js";
import * as sqliteCopy from "./sqlite-file-copy.js";
import { SqliteSnapshotCleanupError } from "./sqlite-lifecycle-errors.js";
import { prepareSqliteReadOnlyCopyInProcess } from "./sqlite-readonly-location.js";
import { isSqliteSnapshotCapacityError } from "./sqlite-snapshot-capacity-error.js";
import { decodeSqliteSnapshotStagingError } from "./sqlite-snapshot-staging-error.js";
import { sqliteSnapshotStagingError } from "./sqlite-snapshot-staging.js";
import * as tmpRoot from "./tmp-openclaw-dir.js";

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
    if (allocation === "cache root") {
      vi.spyOn(tmpRoot, "resolvePreferredOpenClawTmpDir").mockImplementationOnce(() => {
        throw failure;
      });
    } else {
      vi.spyOn(fs, "mkdtempSync").mockImplementationOnce(() => {
        throw failure;
      });
    }

    const error = await prepareSqliteReadOnlyCopyInProcess(databasePath).catch(
      (cause: unknown) => cause,
    );
    expect(isSqliteSnapshotCapacityError(error)).toBe(capacity);
    expect(error).toMatchObject({ cause: failure });
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
