// Covers SQLite WAL maintenance configuration.
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import {
  DEFAULT_SQLITE_WAL_AUTOCHECKPOINT_PAGES,
  configureSqliteConnectionPragmas,
  configureSqliteWalMaintenance,
} from "./sqlite-wal.js";

function createMockDb(): DatabaseSync {
  return {
    exec: vi.fn(),
    prepare: vi.fn(() => ({
      get: vi.fn(() => ({ journal_mode: "delete" })),
    })),
  } as unknown as DatabaseSync;
}

function statfsFixture(type: number): ReturnType<typeof fs.statfsSync> {
  return {
    type,
    bsize: 1024,
    blocks: 1,
    bfree: 1,
    bavail: 1,
    files: 0,
    ffree: 0,
  };
}

describe("sqlite WAL maintenance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("enables WAL mode and explicit autocheckpointing", () => {
    const db = createMockDb();

    configureSqliteWalMaintenance(db, { checkpointIntervalMs: 0 });

    expect(db["exec"]).toHaveBeenNthCalledWith(1, "PRAGMA journal_mode = WAL;");
    expect(db["exec"]).toHaveBeenNthCalledWith(
      2,
      `PRAGMA wal_autocheckpoint = ${DEFAULT_SQLITE_WAL_AUTOCHECKPOINT_PAGES};`,
    );
  });

  it("uses rollback journaling for databases on NFS-backed volumes", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-nfs-"));
    try {
      const db = createMockDb();
      const statfs = vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0x6969));

      const maintenance = configureSqliteWalMaintenance(db, {
        checkpointIntervalMs: 0,
        databasePath: path.join(tempDir, "missing", "openclaw.sqlite"),
      });

      expect(statfs).toHaveBeenCalledWith(tempDir);
      expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode = DELETE;");
      expect(db["exec"]).not.toHaveBeenCalled();
      expect(maintenance.checkpoint()).toBe(true);
      expect(maintenance.close()).toBe(true);
      expect(db["exec"]).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("refuses NFS-backed databases when SQLite keeps WAL active", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-nfs-"));
    try {
      const db = createMockDb();
      vi.mocked(db["prepare"]).mockReturnValue({
        get: vi.fn(() => ({ journal_mode: "wal" })),
      } as unknown as ReturnType<DatabaseSync["prepare"]>);
      vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0x6969));

      expect(() =>
        configureSqliteWalMaintenance(db, {
          checkpointIntervalMs: 0,
          databaseLabel: "test-db",
          databasePath: path.join(tempDir, "openclaw.sqlite"),
        }),
      ).toThrow(/test-db .*journal_mode=wal/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses mountinfo filesystem names when statfs magic is not enough", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-nfs-"));
    try {
      const db = createMockDb();
      vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
      vi.spyOn(fs, "readFileSync").mockReturnValue(
        `42 12 0:41 / ${tempDir} rw,relatime - nfs4 server:/share rw\n`,
      );

      configureSqliteWalMaintenance(db, {
        checkpointIntervalMs: 0,
        databasePath: path.join(tempDir, "openclaw.sqlite"),
      });

      expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode = DELETE;");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses mount command filesystem names on platforms without proc mountinfo", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-nfs-"));
    try {
      const db = createMockDb();
      vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
      vi.spyOn(fs, "readFileSync").mockImplementation(() => {
        throw new Error("no proc mountinfo");
      });
      vi.spyOn(childProcess, "execFileSync").mockReturnValue(
        Buffer.from(`server:/share on ${tempDir} (nfs, nodev, nosuid)\n`),
      );

      configureSqliteWalMaintenance(db, {
        checkpointIntervalMs: 0,
        databasePath: path.join(tempDir, "openclaw.sqlite"),
      });

      expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode = DELETE;");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("parses Linux mount command filesystem names when proc mountinfo is unavailable", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-nfs-"));
    try {
      const db = createMockDb();
      vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
      vi.spyOn(fs, "readFileSync").mockImplementation(() => {
        throw new Error("no proc mountinfo");
      });
      vi.spyOn(childProcess, "execFileSync").mockReturnValue(
        Buffer.from(`server:/share on ${tempDir} type nfs4 (rw,relatime)\n`),
      );

      configureSqliteWalMaintenance(db, {
        checkpointIntervalMs: 0,
        databasePath: path.join(tempDir, "openclaw.sqlite"),
      });

      expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode = DELETE;");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("runs lightweight periodic PASSIVE checkpoints and TRUNCATE on close", () => {
    vi.useFakeTimers();
    const db = createMockDb();

    const maintenance = configureSqliteWalMaintenance(db, { checkpointIntervalMs: 100 });
    expect(db["exec"]).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(100);
    expect(db["exec"]).toHaveBeenLastCalledWith("PRAGMA wal_checkpoint(PASSIVE);");
    expect(db["exec"]).toHaveBeenCalledTimes(3);

    expect(maintenance.close()).toBe(true);
    expect(db["exec"]).toHaveBeenLastCalledWith("PRAGMA wal_checkpoint(TRUNCATE);");
    expect(db["exec"]).toHaveBeenCalledTimes(4);

    vi.advanceTimersByTime(200);
    expect(db["exec"]).toHaveBeenCalledTimes(4);
  });

  it("clamps oversized checkpoint intervals before arming timers", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const db = createMockDb();

    const maintenance = configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: Number.MAX_SAFE_INTEGER,
    });

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    maintenance.close();
  });

  it("honors explicit checkpoint mode overrides for periodic and close checkpoints", () => {
    vi.useFakeTimers();
    const db = createMockDb();

    const maintenance = configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 100,
      checkpointMode: "FULL",
    });

    vi.advanceTimersByTime(100);
    expect(db["exec"]).toHaveBeenLastCalledWith("PRAGMA wal_checkpoint(FULL);");

    expect(maintenance.close()).toBe(true);
    expect(db["exec"]).toHaveBeenLastCalledWith("PRAGMA wal_checkpoint(FULL);");
  });

  it("reports checkpoint errors without throwing from background maintenance", () => {
    const db = createMockDb();
    const error = new Error("busy");
    const onCheckpointError = vi.fn();
    vi.mocked(db["exec"]).mockImplementation((sql) => {
      if (sql.includes("wal_checkpoint")) {
        throw error;
      }
    });

    const maintenance = configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      onCheckpointError,
    });

    expect(maintenance.checkpoint()).toBe(false);
    expect(onCheckpointError).toHaveBeenCalledWith(error);
  });

  it("configures connection pragmas before WAL maintenance", () => {
    const db = createMockDb();

    configureSqliteConnectionPragmas(db, {
      busyTimeoutMs: 30_000,
      checkpointIntervalMs: 0,
      foreignKeys: true,
      synchronous: "NORMAL",
    });

    expect(db["exec"]).toHaveBeenNthCalledWith(1, "PRAGMA busy_timeout = 30000;");
    expect(db["exec"]).toHaveBeenNthCalledWith(2, "PRAGMA journal_mode = WAL;");
    expect(db["exec"]).toHaveBeenNthCalledWith(
      3,
      `PRAGMA wal_autocheckpoint = ${DEFAULT_SQLITE_WAL_AUTOCHECKPOINT_PAGES};`,
    );
    expect(db["exec"]).toHaveBeenNthCalledWith(4, "PRAGMA synchronous = NORMAL;");
    expect(db["exec"]).toHaveBeenNthCalledWith(5, "PRAGMA foreign_keys = ON;");
  });

  it("sets busy timeout before rollback journaling on NFS-backed volumes", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-nfs-"));
    try {
      const db = createMockDb();
      vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0x6969));

      configureSqliteConnectionPragmas(db, {
        busyTimeoutMs: 5000,
        checkpointIntervalMs: 0,
        databasePath: path.join(tempDir, "openclaw.sqlite"),
        synchronous: "NORMAL",
      });

      expect(db["exec"]).toHaveBeenNthCalledWith(1, "PRAGMA busy_timeout = 5000;");
      expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode = DELETE;");
      expect(db["exec"]).toHaveBeenNthCalledWith(2, "PRAGMA synchronous = NORMAL;");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
