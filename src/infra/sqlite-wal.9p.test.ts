// Covers the SQLite journal policy for 9p volumes on real databases: gVisor's exclusive gofer keeps WAL,
// other 9p rolls back, and a database written under the old rollback rule keeps its rows when it moves to WAL.
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { configureSqliteWalMaintenance } from "./sqlite-wal.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const V9FS_SUPER_MAGIC = 0x01021997;
// Root mounts as gVisor reports them in /proc/self/mountinfo.
const EXCLUSIVE_GOFER_ROOT =
  "16 15 0:18 / / rw - 9p none rw,trans=fd,rfdno=5,wfdno=5,aname=/,dcache=1000,cache=fscache,disable_fifo_open,overlayfs_stale_read,directfs";
const SHARED_GOFER_ROOT =
  "16 15 0:18 / / rw - 9p none rw,trans=fd,rfdno=5,wfdno=5,aname=/,dcache=1000,cache=remote_revalidating,disable_fifo_open,directfs";
const VIRTIO_9P_ROOT =
  "16 15 0:18 / / rw - 9p hostshare rw,trans=virtio,version=9p2000.L,cache=mmap";

function mock9pVolume(mountinfo: string | null): void {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(fs, "statfsSync").mockReturnValue({
    type: V9FS_SUPER_MAGIC,
    bsize: 1024,
    blocks: 1,
    bfree: 1,
    bavail: 1,
    files: 0,
    frsize: 1024,
    ffree: 0,
  });
  const readFileSync = fs.readFileSync.bind(fs);
  vi.spyOn(fs, "readFileSync").mockImplementation(((
    file: fs.PathOrFileDescriptor,
    ...rest: unknown[]
  ) => {
    if (file !== "/proc/self/mountinfo") {
      return (readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
    }
    if (mountinfo === null) {
      throw new Error("no proc mountinfo");
    }
    return `${mountinfo}\n`;
  }) as typeof fs.readFileSync);
  if (mountinfo === null) {
    vi.spyOn(childProcess, "execFileSync").mockImplementation(() => {
      throw new Error("mount unavailable");
    });
  }
}

function openDatabase(databasePath: string): DatabaseSync {
  return new (requireNodeSqlite().DatabaseSync)(databasePath);
}

function journalMode(db: DatabaseSync): unknown {
  return (db.prepare("PRAGMA journal_mode;").get() as { journal_mode: unknown }).journal_mode;
}

function rowCount(db: DatabaseSync): unknown {
  return (db.prepare("SELECT count(*) AS n FROM t").get() as { n: unknown }).n;
}

/** A WAL database with one row and a second connection holding a read transaction, as a replicator would. */
function seedWalDatabaseWithReader(databasePath: string): DatabaseSync {
  const seed = openDatabase(databasePath);
  seed.exec("PRAGMA journal_mode = WAL; CREATE TABLE t(x); INSERT INTO t VALUES (1);");
  seed.close();
  const reader = openDatabase(databasePath);
  reader.exec("BEGIN");
  reader.prepare("SELECT count(*) FROM t").get();
  return reader;
}

describe("sqlite WAL policy on 9p volumes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps WAL on gVisor's exclusive 9p gofer root while another connection holds the database", () => {
    const databasePath = path.join(tempDirs.make("openclaw-sqlite-gvisor-"), "openclaw.sqlite");
    const reader = seedWalDatabaseWithReader(databasePath);
    const db = openDatabase(databasePath);
    try {
      mock9pVolume(EXCLUSIVE_GOFER_ROOT);
      const maintenance = configureSqliteWalMaintenance(db, {
        busyTimeoutMs: 50,
        checkpointIntervalMs: 0,
        databasePath,
      });

      expect(journalMode(db)).toBe("wal");
      db.exec("INSERT INTO t VALUES (2)");
      expect(rowCount(db)).toBe(2);
      maintenance.close();
    } finally {
      reader.exec("ROLLBACK");
      reader.close();
      db.close();
    }
  });

  it("still fails to leave WAL on a shared gofer mount while another connection holds the database", () => {
    const databasePath = path.join(tempDirs.make("openclaw-sqlite-9p-shared-"), "openclaw.sqlite");
    const reader = seedWalDatabaseWithReader(databasePath);
    const db = openDatabase(databasePath);
    try {
      mock9pVolume(SHARED_GOFER_ROOT);

      expect(() =>
        configureSqliteWalMaintenance(db, {
          busyTimeoutMs: 50,
          checkpointIntervalMs: 0,
          databasePath,
        }),
      ).toThrow(/database is locked/u);
    } finally {
      reader.exec("ROLLBACK");
      reader.close();
      db.close();
    }
  });

  it.each([
    ["a shared gVisor gofer mount", SHARED_GOFER_ROOT],
    ["9p over virtio", VIRTIO_9P_ROOT],
    ["unreadable mount metadata", null],
  ])("uses rollback journaling for 9p volumes on %s", (_label, mountinfo) => {
    const databasePath = path.join(tempDirs.make("openclaw-sqlite-9p-"), "openclaw.sqlite");
    const db = openDatabase(databasePath);
    try {
      mock9pVolume(mountinfo);
      const maintenance = configureSqliteWalMaintenance(db, {
        checkpointIntervalMs: 0,
        databasePath,
      });

      expect(journalMode(db)).toBe("delete");
      db.exec("CREATE TABLE t(x); INSERT INTO t VALUES (1);");
      expect(rowCount(db)).toBe(1);
      maintenance.close();
    } finally {
      db.close();
    }
  });

  it("moves a database written under the 9p rollback rule to WAL with its rows intact", () => {
    const databasePath = path.join(tempDirs.make("openclaw-sqlite-9p-upgrade-"), "openclaw.sqlite");
    const before = openDatabase(databasePath);
    try {
      mock9pVolume(SHARED_GOFER_ROOT);
      const maintenance = configureSqliteWalMaintenance(before, {
        checkpointIntervalMs: 0,
        databasePath,
      });
      expect(journalMode(before)).toBe("delete");
      before.exec("CREATE TABLE t(x); INSERT INTO t VALUES (1), (2), (3);");
      maintenance.close();
    } finally {
      before.close();
    }
    vi.restoreAllMocks();

    const after = openDatabase(databasePath);
    try {
      mock9pVolume(EXCLUSIVE_GOFER_ROOT);
      const maintenance = configureSqliteWalMaintenance(after, {
        checkpointIntervalMs: 0,
        databasePath,
      });

      expect(journalMode(after)).toBe("wal");
      expect(rowCount(after)).toBe(3);
      after.exec("INSERT INTO t VALUES (4)");
      expect(rowCount(after)).toBe(4);
      maintenance.close();
    } finally {
      after.close();
    }
  });
});
