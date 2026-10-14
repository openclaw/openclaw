// Covers the SQLite journal policy for 9p volumes: gVisor's exclusive gofer keeps WAL, other 9p rolls back.
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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

function createMockDb(): DatabaseSync {
  return {
    close: vi.fn(),
    exec: vi.fn(),
    isOpen: true,
    location: () => "untracked.sqlite",
    prepare: vi.fn((sql: string) => ({
      get: vi.fn(() => ({ journal_mode: sql === "PRAGMA journal_mode;" ? "wal" : "delete" })),
    })),
  } as unknown as DatabaseSync;
}

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

describe("sqlite WAL policy on 9p volumes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps WAL on gVisor's exclusive 9p gofer root", () => {
    const tempDir = tempDirs.make("openclaw-sqlite-gvisor-");
    const db = createMockDb();
    mock9pVolume(EXCLUSIVE_GOFER_ROOT);

    configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      databasePath: path.join(tempDir, "openclaw.sqlite"),
    });

    expect(db["prepare"]).not.toHaveBeenCalledWith("PRAGMA journal_mode = DELETE;");
    expect(db["exec"]).toHaveBeenNthCalledWith(1, "PRAGMA journal_mode = WAL;");
  });

  it.each([
    ["a shared gVisor gofer mount", SHARED_GOFER_ROOT],
    ["9p over virtio", VIRTIO_9P_ROOT],
    ["unreadable mount metadata", null],
  ])("uses rollback journaling for 9p volumes on %s", (_label, mountinfo) => {
    const tempDir = tempDirs.make("openclaw-sqlite-9p-");
    const db = createMockDb();
    mock9pVolume(mountinfo);

    configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      databasePath: path.join(tempDir, "openclaw.sqlite"),
    });

    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode = DELETE;");
  });
});
