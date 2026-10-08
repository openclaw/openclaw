import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { startSqliteConcurrentWriter } from "./sqlite-concurrent-writer.test-support.js";
import { readMainDatabasePosixLocks } from "./sqlite-posix-locks.test-support.js";
import {
  prepareSqliteReadOnlyLocationInProcess,
  prepareSqliteReadOnlyLocationSyncInProcess,
  SqliteSourceChangedError,
} from "./sqlite-readonly-location.js";
import { withSqliteReadOnlyWorkerScope } from "./sqlite-readonly-worker.js";
import {
  prepareSqliteReadOnlyLocation,
  prepareSqliteReadOnlyLocationSync,
} from "./sqlite-snapshot-source.js";
import { sqliteWorkerPreloadEnv } from "./sqlite-worker-preload.test-support.js";

const sqlite = requireNodeSqlite();
const writers: Array<ReturnType<typeof startSqliteConcurrentWriter>> = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await Promise.all(writers.splice(0).map((writer) => writer.stop()));
    } finally {
      cleanup();
    }
  });
});

function createTempDatabasePath(sql?: string): string {
  const pathname = path.join(tempDirs.make("openclaw-sqlite-readonly-"), "state.sqlite");
  if (sql) {
    const database = new sqlite.DatabaseSync(pathname);
    try {
      database.exec(sql);
    } finally {
      database.close();
    }
  }
  return pathname;
}

function readFamily(pathname: string): Map<string, Buffer> {
  const family = new Map<string, Buffer>();
  for (const suffix of ["", "-journal", "-shm", "-wal"]) {
    const memberPath = `${pathname}${suffix}`;
    if (fs.existsSync(memberPath)) {
      family.set(suffix, fs.readFileSync(memberPath));
    }
  }
  return family;
}

function readLogicalFamily(pathname: string): Map<string, Buffer> {
  const family = readFamily(pathname);
  family.delete("-shm");
  return family;
}

describe("prepareSqliteReadOnlyLocation", () => {
  it("keeps each scoped artifact-preserving inspection byte-neutral across writer commits", async () => {
    const cacheRoot = path.join(tempDirs.make("openclaw-sqlite-snapshot-cache-"), "missing");
    const databasePath = createTempDatabasePath();
    const writer = new sqlite.DatabaseSync(databasePath);
    try {
      writer.exec(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE probe(value TEXT)",
      );
      await withEnvAsync({ XDG_CACHE_HOME: cacheRoot }, () =>
        withSqliteReadOnlyWorkerScope(async () => {
          for (const value of ["first", "second"]) {
            writer.prepare("INSERT INTO probe VALUES (?)").run(value);
            const familyBefore = readFamily(databasePath);
            const prepared = await prepareSqliteReadOnlyLocation(databasePath, {
              preserveSourceArtifacts: true,
            });
            try {
              expect(prepared.location.startsWith(`${cacheRoot}${path.sep}`)).toBe(true);
              expect(fs.statSync(path.dirname(prepared.location)).mode & 0o777).toBe(0o700);
              expect(readFamily(databasePath)).toEqual(familyBefore);
              const snapshot = new sqlite.DatabaseSync(prepared.location, { readOnly: true });
              try {
                expect(
                  snapshot.prepare("SELECT value FROM probe ORDER BY rowid DESC LIMIT 1").get(),
                ).toEqual({ value });
              } finally {
                snapshot.close();
              }
            } finally {
              expect(prepared.cleanup()).toBe(true);
            }
          }
        }),
      );
    } finally {
      writer.close();
    }
  });

  it.each([13, 778])(
    "retains SQLite destination write failure %i and identifies the snapshot cache",
    async (errcode) => {
      const cacheRoot = tempDirs.make("openclaw-sqlite-snapshot-full-");
      const databasePath = createTempDatabasePath("CREATE TABLE probe (value TEXT);");
      const quotaError = Object.assign(new Error("disk I/O error"), {
        code: "ERR_SQLITE_ERROR",
        errcode,
      });
      vi.spyOn(sqlite, "backup").mockRejectedValueOnce(quotaError);

      await withEnvAsync({ XDG_CACHE_HOME: cacheRoot }, async () => {
        await expect(prepareSqliteReadOnlyLocationInProcess(databasePath)).rejects.toMatchObject({
          cause: quotaError,
          message: expect.stringContaining(`SQLite errcode=${errcode}`),
        });
      });
      expect(fs.readdirSync(path.join(cacheRoot, "openclaw"))).toEqual([]);
    },
  );

  it.each([
    {
      mode: "async backup",
      prepare: prepareSqliteReadOnlyLocationInProcess,
      empty: false,
      code: "EDQUOT",
    },
    {
      mode: "async copy",
      prepare: prepareSqliteReadOnlyLocationInProcess,
      empty: true,
      code: "EACCES",
    },
    {
      mode: "sync copy",
      prepare: prepareSqliteReadOnlyLocationSyncInProcess,
      empty: false,
      code: "EROFS",
    },
  ])(
    "identifies $mode private cache allocation failure $code before backup or copying",
    async ({ code, empty, prepare }) => {
      const cacheRoot = tempDirs.make("openclaw-sqlite-snapshot-allocation-");
      const databasePath = createTempDatabasePath();
      if (empty) {
        fs.writeFileSync(databasePath, "");
      } else {
        const database = new sqlite.DatabaseSync(databasePath);
        database.exec("CREATE TABLE probe (value TEXT);");
        database.close();
      }
      const stagingRoot = path.join(cacheRoot, "openclaw");
      const allocationError = Object.assign(new Error("snapshot directory allocation failed"), {
        code,
        path: path.join(stagingRoot, "openclaw-sqlite-readonly-stage"),
      });
      const backup = vi.spyOn(sqlite, "backup");
      const write = vi.spyOn(fs, "writeSync");
      vi.spyOn(fs, "mkdtempSync").mockImplementationOnce(() => {
        throw allocationError;
      });

      await withEnvAsync({ XDG_CACHE_HOME: cacheRoot }, async () => {
        const error = await Promise.resolve()
          .then(() => prepare(databasePath))
          .catch((cause: unknown) => cause);
        expect(error).toMatchObject({
          cause: allocationError,
          message: expect.stringContaining(stagingRoot),
        });
        expect((error as Error).message).toContain("XDG_CACHE_HOME");
        expect((error as Error).message.includes("free disk space/quota")).toBe(
          code === "ENOSPC" || code === "EDQUOT",
        );
        expect((error as Error).message.match(/snapshot staging root/gu)).toHaveLength(1);
      });

      expect(backup).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(fs.readdirSync(stagingRoot)).toEqual([]);
    },
  );

  it("preserves source failures inside the snapshot cache without staging guidance", async () => {
    const cacheRoot = tempDirs.make("openclaw-sqlite-snapshot-cached-source-");
    const stagingRoot = path.join(cacheRoot, "openclaw");
    fs.mkdirSync(stagingRoot, { mode: 0o700 });
    const databasePath = path.join(stagingRoot, "source.sqlite");
    const database = new sqlite.DatabaseSync(databasePath);
    database.exec("CREATE TABLE probe (value TEXT);");
    database.close();
    const sourceError = Object.assign(new Error("source permission denied"), {
      code: "EACCES",
      path: databasePath,
    });
    vi.spyOn(sqlite, "backup").mockRejectedValueOnce(sourceError);

    await withEnvAsync({ XDG_CACHE_HOME: cacheRoot }, async () => {
      const error = await prepareSqliteReadOnlyLocationInProcess(databasePath).catch(
        (cause: unknown) => cause,
      );
      expect(error).toBe(sourceError);
      expect((error as Error).message).not.toMatch(/staging|quota|XDG_CACHE_HOME/u);
    });
    expect(fs.readdirSync(stagingRoot)).toEqual(["source.sqlite"]);
  });

  it("identifies filesystem failures whose path belongs to the staging destination", async () => {
    const cacheRoot = tempDirs.make("openclaw-sqlite-snapshot-destination-path-");
    const databasePath = createTempDatabasePath("CREATE TABLE probe (value TEXT);");
    vi.spyOn(sqlite, "backup").mockImplementationOnce(async (_source, destination) => {
      throw Object.assign(new Error("destination permission denied"), {
        code: "EACCES",
        path: String(destination),
      });
    });

    await withEnvAsync({ XDG_CACHE_HOME: cacheRoot }, async () => {
      await expect(prepareSqliteReadOnlyLocationInProcess(databasePath)).rejects.toMatchObject({
        cause: { code: "EACCES", path: expect.stringContaining(cacheRoot) },
        message: expect.stringContaining(cacheRoot),
      });
    });
    expect(fs.readdirSync(path.join(cacheRoot, "openclaw"))).toEqual([]);
  });

  it("preserves source corruption without reporting a snapshot staging quota failure", async () => {
    const cacheRoot = tempDirs.make("openclaw-sqlite-snapshot-corrupt-source-");
    const databasePath = createTempDatabasePath(
      "CREATE TABLE probe (value TEXT); INSERT INTO probe VALUES ('corrupt');",
    );

    const descriptor = fs.openSync(databasePath, "r+");
    try {
      fs.writeSync(descriptor, Buffer.from([0]), 0, 1, 100);
    } finally {
      fs.closeSync(descriptor);
    }

    const corruptSource = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(() => corruptSource.prepare("PRAGMA quick_check;").get()).toThrow(
        /database disk image is malformed/u,
      );
    } finally {
      corruptSource.close();
    }

    await withEnvAsync({ XDG_CACHE_HOME: cacheRoot }, async () => {
      const inProcessError = await prepareSqliteReadOnlyLocationInProcess(databasePath).catch(
        (error: unknown) => error,
      );
      const workerError = await prepareSqliteReadOnlyLocation(databasePath).catch(
        (error: unknown) => error,
      );

      expect(inProcessError).toMatchObject({
        code: "ERR_SQLITE_ERROR",
        errcode: 11,
        message: "database disk image is malformed",
      });
      expect(workerError).toBeInstanceOf(Error);
      expect((workerError as Error).message).toContain(
        "database disk image is malformed (code=ERR_SQLITE_ERROR, errcode=11)",
      );
      expect((workerError as Error).message).not.toMatch(/staging|quota|XDG_CACHE_HOME/u);
    });
  });

  it.each(["EDQUOT"])(
    "keeps synchronous destination %s failures actionable without changing the source",
    async (code) => {
      const cacheRoot = tempDirs.make("openclaw-sqlite-snapshot-sync-full-");
      const databasePath = createTempDatabasePath("CREATE TABLE probe (value TEXT);");
      const before = readFamily(databasePath);
      const quotaError = Object.assign(new Error("Disk quota exceeded"), { code });
      vi.spyOn(fs, "writeSync").mockImplementationOnce(() => {
        throw quotaError;
      });

      await withEnvAsync({ XDG_CACHE_HOME: cacheRoot }, async () => {
        expect(() => prepareSqliteReadOnlyLocationSyncInProcess(databasePath)).toThrowError(
          expect.objectContaining({
            cause: quotaError,
            message: expect.stringContaining(cacheRoot),
          }),
        );
      });
      expect(readFamily(databasePath)).toEqual(before);
      expect(fs.readdirSync(path.join(cacheRoot, "openclaw"))).toEqual([]);
    },
  );

  it.each([
    {
      boundary: "Node stderr buffer end",
      stderr: `${"x".repeat(1024 * 1024 - 1)}🤖${"x".repeat(4_096)}`,
      expectedTail: `${"x".repeat(3_999)}�`,
    },
  ])("keeps worker stderr valid at the $boundary", async ({ stderr, expectedTail }) => {
    const tempDir = tempDirs.make("openclaw-sqlite-readonly-stderr-");
    const preloadPath = path.join(tempDir, "stderr-preload.cjs");
    fs.writeFileSync(
      preloadPath,
      `process.once("beforeExit", () => process.stderr.write(${JSON.stringify(stderr)}));`,
    );
    const missingPath = path.join(tempDir, "missing.db");

    await withEnvAsync(sqliteWorkerPreloadEnv(preloadPath), async () => {
      let message = "";
      try {
        await prepareSqliteReadOnlyLocation(missingPath);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message.split("stderr (tail): ")[1]).toBe(expectedTail);
    });
  });

  it("names retry count and guidance for artifact-preserving synchronous inspection", () => {
    const databasePath = createTempDatabasePath(
      "PRAGMA journal_mode = WAL; CREATE TABLE probe (value TEXT); INSERT INTO probe VALUES ('ok');",
    );
    const canonicalPath = fs.realpathSync.native(databasePath);
    const openSync = fs.openSync.bind(fs);
    vi.spyOn(fs, "openSync").mockImplementation((pathname, flags, mode) => {
      if (path.resolve(String(pathname)) === canonicalPath) {
        throw Object.assign(new Error("simulated source disappearance"), { code: "ENOENT" });
      }
      return openSync(pathname, flags, mode);
    });

    let error: unknown;
    try {
      prepareSqliteReadOnlyLocationSyncInProcess(databasePath);
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof Error);
    expect.soft(error.message).toContain("after 10 read-only inspection attempts");
    expect.soft(error.message).toContain("the database may be under concurrent write activity");
    expect
      .soft(error.message)
      .toContain("Wait a moment for write activity to settle, then retry the inspection");
    expect.soft(error.message).toContain(canonicalPath);
    expect.soft(error.cause).toBeInstanceOf(SqliteSourceChangedError);
    expect.soft(error.cause).toMatchObject({
      message: `SQLite source disappeared: ${canonicalPath}`,
    });
    expect.soft(error.message).not.toContain("SQLite source disappeared");
  });

  it.runIf(process.platform === "linux")(
    "keeps a live WAL connection's POSIX locks in the owning process",
    async () => {
      const databasePath = createTempDatabasePath();
      const writer = new sqlite.DatabaseSync(databasePath);
      writer.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE writes (id INTEGER PRIMARY KEY);
        INSERT INTO writes DEFAULT VALUES;
      `);
      const locksBefore = readMainDatabasePosixLocks(databasePath);
      const cleanups: Array<() => boolean> = [];
      try {
        expect(locksBefore).toEqual([
          { length: 510, pid: process.pid, start: 1073741826, type: "read" },
        ]);

        const preparedAsync = await prepareSqliteReadOnlyLocation(databasePath);
        cleanups.push(preparedAsync.cleanup);
        expect(readMainDatabasePosixLocks(databasePath)).toEqual(locksBefore);
        expect(preparedAsync.cleanup()).toBe(true);

        const preparedSync = prepareSqliteReadOnlyLocationSync(databasePath);
        cleanups.push(preparedSync.cleanup);
        expect(readMainDatabasePosixLocks(databasePath)).toEqual(locksBefore);
        expect(preparedSync.cleanup()).toBe(true);

        await withSqliteReadOnlyWorkerScope(async () => {
          for (const preserveSourceArtifacts of [true, false, true]) {
            const prepared = await prepareSqliteReadOnlyLocation(databasePath, {
              preserveSourceArtifacts,
            });
            cleanups.push(prepared.cleanup);
            expect(readMainDatabasePosixLocks(databasePath)).toEqual(locksBefore);
            expect(prepared.cleanup()).toBe(true);
          }
        });

        const characterized = prepareSqliteReadOnlyLocationSyncInProcess(databasePath);
        cleanups.push(characterized.cleanup);
        expect(readMainDatabasePosixLocks(databasePath)).toEqual([]);
        expect(characterized.cleanup()).toBe(true);
      } finally {
        for (const cleanup of cleanups) {
          cleanup();
        }
        writer.close();
      }
    },
  );

  it("retries a same-size WAL reset and publishes only the new consistent pair", async () => {
    const livePath = createTempDatabasePath();
    const writer = new sqlite.DatabaseSync(livePath);
    writer.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE before_reset (value TEXT PRIMARY KEY);
      CREATE TABLE after_reset (value TEXT PRIMARY KEY);
      PRAGMA wal_checkpoint(TRUNCATE);
      INSERT INTO before_reset VALUES ('A');
    `);
    const databasePath = createTempDatabasePath();
    fs.copyFileSync(livePath, databasePath);
    fs.copyFileSync(`${livePath}-wal`, `${databasePath}-wal`);
    writer.close();
    expect(fs.existsSync(`${databasePath}-shm`)).toBe(false);
    const walSizeBeforeReset = fs.statSync(`${databasePath}-wal`).size;
    const fsyncSync = fs.fsyncSync.bind(fs);
    let injected = false;
    let raceWriter: DatabaseSync | undefined;
    let sourceAfterReset: Map<string, Buffer> | undefined;
    vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
      fsyncSync(descriptor);
      if (!injected) {
        injected = true;
        raceWriter = new sqlite.DatabaseSync(databasePath);
        raceWriter.exec(`
          PRAGMA wal_checkpoint(TRUNCATE);
          INSERT INTO after_reset VALUES ('B');
        `);
        sourceAfterReset = readLogicalFamily(databasePath);
      }
    });

    try {
      const prepared = await prepareSqliteReadOnlyLocationInProcess(databasePath);
      const snapshot = new sqlite.DatabaseSync(prepared.location, { readOnly: true });
      try {
        expect(snapshot.prepare("SELECT value FROM before_reset").all()).toEqual([{ value: "A" }]);
        expect(snapshot.prepare("SELECT value FROM after_reset").all()).toEqual([{ value: "B" }]);
        expect(snapshot.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        snapshot.close();
        expect(prepared.cleanup()).toBe(true);
      }
      expect(injected).toBe(true);
      expect(fs.statSync(`${databasePath}-wal`).size).toBe(walSizeBeforeReset);
      expect(readLogicalFamily(databasePath)).toEqual(sourceAfterReset);
    } finally {
      raceWriter?.close();
    }
  });

  it("rolls back contended MEMORY writes before committing another batch", async () => {
    const databasePath = createTempDatabasePath();
    const reader = new sqlite.DatabaseSync(databasePath);
    reader.exec(
      "CREATE TABLE pair (name TEXT PRIMARY KEY, value INTEGER NOT NULL); INSERT INTO pair VALUES ('left', 0), ('right', 0); BEGIN;",
    );
    expect(reader.prepare("SELECT value FROM pair ORDER BY name").all()).toEqual([
      { value: 0 },
      { value: 0 },
    ]);
    const writer = startSqliteConcurrentWriter(databasePath, "MEMORY", 0);
    writers.push(writer);
    try {
      // Hold a native reader until COMMIT reports BUSY. Only the producer
      // wait is disabled; real locking and rollback still own the outcome.
      expect(await writer.waitFor("busy")).toEqual({
        event: "busy",
        commits: 0,
        transaction: false,
      });
      expect(reader.prepare("SELECT value FROM pair ORDER BY name").all()).toEqual([
        { value: 0 },
        { value: 0 },
      ]);
      reader.exec("ROLLBACK");
      expect((await writer.waitFor("ready")).commits).toBeGreaterThan(0);
      expect((await writer.progress()).commits).toBeGreaterThan(1);
      await writer.stop();
      const values = reader
        .prepare("SELECT value FROM pair ORDER BY name")
        .all()
        .map((row) => row.value);
      expect(values).toHaveLength(2);
      expect(values[0]).toBeGreaterThan(0);
      expect(values[0]).toBe(values[1]);
      expect(reader.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      reader.close();
      await writer.stop();
    }
  });

  it("backs up live MEMORY-journal transactions atomically", async () => {
    const databasePath = createTempDatabasePath(`
      CREATE TABLE pair (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO pair VALUES ('left', 0), ('right', 0);
      CREATE TABLE payload (data BLOB NOT NULL);
      INSERT INTO payload VALUES (zeroblob(8388608));
    `);
    const writer = startSqliteConcurrentWriter(databasePath, "MEMORY");
    writers.push(writer);
    try {
      const ready = await writer.waitFor("ready");
      expect(ready.commits).toBeGreaterThan(0);
      expect(writer.pid).not.toBe(process.pid);
      // Hold a real half-written transaction so read admission does not race
      // an unbounded stream of commits; the snapshot must exclude that write.
      const held = await writer.holdTransaction();
      expect(held.commits).toBeGreaterThanOrEqual(ready.commits);
      expect(held.transaction).toBe(true);
      expect(held.values).toEqual([held.commits + 1, held.commits]);

      const prepared = await prepareSqliteReadOnlyLocationInProcess(databasePath);
      const snapshot = new sqlite.DatabaseSync(prepared.location, { readOnly: true });
      try {
        const values = snapshot
          .prepare("SELECT value FROM pair ORDER BY name")
          .all()
          .map((row) => (row as { value: number }).value);
        expect(values).toEqual([held.commits, held.commits]);
        expect(snapshot.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        snapshot.close();
        expect(prepared.cleanup()).toBe(true);
      }
      const progress = await writer.progress();
      expect(progress.commits).toBeGreaterThan(held.commits);
      expect(progress.transaction).toBe(false);
      const unfinished = await writer.holdTransaction();
      expect(unfinished.transaction).toBe(true);
      expect(unfinished.values).toEqual([unfinished.commits + 1, unfinished.commits]);
      await writer.stop();
      const source = new sqlite.DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(source.prepare("SELECT value FROM pair ORDER BY name").all()).toEqual([
          { value: unfinished.commits },
          { value: unfinished.commits },
        ]);
        expect(source.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        source.close();
      }
    } finally {
      await writer.stop();
    }
  });

  it("retries a transient missing pathname without publishing the unverified attempt", async () => {
    const databasePath = createTempDatabasePath(
      "CREATE TABLE probe (value TEXT); INSERT INTO probe VALUES ('ok');",
    );
    const canonicalDatabasePath = fs.realpathSync.native(databasePath);
    const statSync = fs.statSync.bind(fs);
    let injected = false;
    vi.spyOn(fs, "statSync").mockImplementation(((pathname, options) => {
      if (!injected && path.resolve(String(pathname)) === canonicalDatabasePath) {
        injected = true;
        const error = new Error("missing");
        (error as NodeJS.ErrnoException).code = "ENOENT";
        throw error;
      }
      return statSync(pathname, options as never);
    }) as typeof fs.statSync);

    const prepared = await prepareSqliteReadOnlyLocationInProcess(databasePath);
    const snapshot = new sqlite.DatabaseSync(prepared.location, { readOnly: true });
    try {
      expect(snapshot.prepare("SELECT value FROM probe").all()).toEqual([{ value: "ok" }]);
      expect(injected).toBe(true);
    } finally {
      snapshot.close();
      expect(prepared.cleanup()).toBe(true);
    }
  });

  it("copies an orphan SHM privately without creating a source WAL", async () => {
    const databasePath = createTempDatabasePath(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE probe (value TEXT);
      INSERT INTO probe VALUES ('committed');
      PRAGMA wal_checkpoint(TRUNCATE);
    `);
    fs.rmSync(`${databasePath}-wal`, { force: true });
    const orphanShm = Buffer.alloc(32 * 1024, 0x5a);
    fs.writeFileSync(`${databasePath}-shm`, orphanShm, { mode: 0o600 });
    const beforeMain = fs.readFileSync(databasePath);
    const beforeEntries = fs.readdirSync(path.dirname(databasePath)).toSorted();

    const prepared = await prepareSqliteReadOnlyLocationInProcess(databasePath);
    const snapshot = new sqlite.DatabaseSync(prepared.location, { readOnly: true });
    expect(snapshot.prepare("SELECT value FROM probe").all()).toEqual([{ value: "committed" }]);
    snapshot.close();
    expect(prepared.cleanup()).toBe(true);

    expect(fs.existsSync(`${databasePath}-wal`)).toBe(false);
    expect(fs.readFileSync(`${databasePath}-shm`)).toEqual(orphanShm);
    expect(fs.readFileSync(databasePath)).toEqual(beforeMain);
    expect(fs.readdirSync(path.dirname(databasePath)).toSorted()).toEqual(beforeEntries);
  });
});

it.each([
  { mode: "async", prepare: prepareSqliteReadOnlyLocationInProcess },
  { mode: "sync", prepare: prepareSqliteReadOnlyLocationSync },
  {
    mode: "artifact-preserving",
    prepare: (pathname: string) =>
      prepareSqliteReadOnlyLocation(pathname, { preserveSourceArtifacts: true }),
  },
])(
  "backs up an active WAL database during $mode inspection while another connection keeps writing",
  async ({ prepare }) => {
    const databasePath = createTempDatabasePath();
    const seed = new sqlite.DatabaseSync(databasePath);
    seed.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE writes (sequence INTEGER PRIMARY KEY);
    CREATE TABLE payload (data BLOB NOT NULL);
    INSERT INTO payload VALUES (zeroblob(16777216));
    PRAGMA wal_checkpoint(TRUNCATE);
  `);
    seed.close();
    const writer = startSqliteConcurrentWriter(databasePath, "WAL");
    writers.push(writer);
    try {
      const ready = await writer.waitFor("ready");
      expect(ready.commits).toBeGreaterThan(0);
      expect(writer.pid).not.toBe(process.pid);

      const prepared = await prepare(databasePath);
      const snapshot = new sqlite.DatabaseSync(prepared.location, { readOnly: true });
      try {
        expect(snapshot.prepare("PRAGMA integrity_check").get()).toEqual({
          integrity_check: "ok",
        });
        expect(snapshot.prepare("SELECT COUNT(*) AS count FROM payload").get()).toEqual({
          count: 1,
        });
        expect(
          snapshot.prepare("SELECT COUNT(*) AS count FROM writes").get()?.count,
        ).toBeGreaterThan(0);
      } finally {
        snapshot.close();
        expect(prepared.cleanup()).toBe(true);
      }
      expect((await writer.progress()).commits).toBeGreaterThan(ready.commits);
    } finally {
      await writer.stop();
    }
  },
);
