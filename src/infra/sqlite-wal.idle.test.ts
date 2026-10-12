import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "./node-sqlite.js";
import { configureSqliteWalMaintenance } from "./sqlite-wal.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("idle WAL checkpoint ticks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("skips completed idle ticks and resumes after writes on either connection", async () => {
    vi.useFakeTimers();
    const databasePath = path.join(tempDirs.make("openclaw-wal-idle-"), "state.sqlite");
    const writer = openNodeSqliteDatabase(databasePath);
    let admitted = true;
    const maintenance = configureSqliteWalMaintenance(writer, {
      databasePath,
      autoCheckpointPages: 0,
      runMaintenance: (operation) => admitted && operation(),
    });
    writer.exec("CREATE TABLE events(value TEXT)");
    const sibling = openNodeSqliteDatabase(databasePath);
    const statements = trackSqliteStatementExecutions(writer, ["checkpoint"], (sql) =>
      /wal_checkpoint/iu.test(sql) ? "checkpoint" : null,
    );
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(maintenance.health?.state).toBe("complete");
      expect(statements.counts.checkpoint).toBe(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(statements.counts.checkpoint).toBe(1);

      sibling.exec("INSERT INTO events VALUES ('sibling')");
      admitted = false;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(statements.counts.checkpoint).toBe(1);
      admitted = true;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(statements.counts.checkpoint).toBe(2);
      expect(maintenance.health?.state).toBe("complete");
      writer.exec("INSERT INTO events VALUES ('owner')");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(statements.counts.checkpoint).toBe(3);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(statements.counts.checkpoint).toBe(3);
      expect(sibling.prepare("SELECT value FROM events ORDER BY rowid").all()).toEqual([
        { value: "sibling" },
        { value: "owner" },
      ]);
    } finally {
      statements.restore();
      sibling.close();
      maintenance.close();
      writer.close();
    }
  });

  it("retries a blocked checkpoint after its reader releases without another write", async () => {
    vi.useFakeTimers();
    const databasePath = path.join(tempDirs.make("openclaw-wal-reader-"), "state.sqlite");
    const writer = openNodeSqliteDatabase(databasePath);
    const maintenance = configureSqliteWalMaintenance(writer, {
      databasePath,
      autoCheckpointPages: 0,
    });
    writer.exec("CREATE TABLE events(value TEXT)");
    const reader = openNodeSqliteDatabase(databasePath);
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      reader.exec("BEGIN");
      reader.prepare("SELECT value FROM events").all();
      writer.exec("INSERT INTO events VALUES ('retained')");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(maintenance.health?.state).toBe("blocked");
      reader.exec("ROLLBACK");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(maintenance.health?.state).toBe("complete");
      expect(maintenance.health?.checkpointedFrames).toBeGreaterThan(0);
    } finally {
      reader.close();
      maintenance.close();
      writer.close();
    }
  });

  it("keeps checkpointing untracked connections whose write revision is unknown", async () => {
    vi.useFakeTimers();
    const databasePath = path.join(tempDirs.make("openclaw-wal-untracked-"), "state.sqlite");
    const writer = new (requireNodeSqlite().DatabaseSync)(databasePath);
    const maintenance = configureSqliteWalMaintenance(writer, { databasePath });
    const statements = trackSqliteStatementExecutions(writer, ["checkpoint"], (sql) =>
      /wal_checkpoint/iu.test(sql) ? "checkpoint" : null,
    );
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(statements.counts.checkpoint).toBe(3);
    } finally {
      statements.restore();
      maintenance.close();
      writer.close();
    }
  });
});
