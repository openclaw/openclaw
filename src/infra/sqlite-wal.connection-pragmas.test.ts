import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { configureSqliteConnectionPragmas } from "./sqlite-wal.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("SQLite connection pragma acquisition", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(["synchronous = NORMAL", "foreign_keys = ON"])(
    "releases unpublished maintenance when PRAGMA %s fails",
    (pragma) => {
      vi.useFakeTimers();
      const dbPath = path.join(tempDirs.make("openclaw-sqlite-pragma-failure-"), "state.sqlite");
      const { DatabaseSync } = requireNodeSqlite();
      const db = new DatabaseSync(dbPath);
      const failure = new Error("connection pragma failed");
      try {
        db.exec("CREATE TABLE payload (value TEXT); INSERT INTO payload VALUES ('committed');");
        const exec = db.exec.bind(db);
        const execSpy = vi.spyOn(db, "exec").mockImplementation((sql) => {
          if (sql === `PRAGMA ${pragma};`) {
            expect(vi.getTimerCount()).toBe(1);
            throw failure;
          }
          exec(sql);
        });
        for (let attempt = 0; attempt < 3; attempt++) {
          expect(() =>
            configureSqliteConnectionPragmas(db, {
              databasePath: dbPath,
              foreignKeys: true,
              synchronous: "NORMAL",
            }),
          ).toThrow(failure);
          expect(vi.getTimerCount()).toBe(0);
          expect(db.isOpen).toBe(true);
        }
        execSpy.mockRestore();
        const maintenance = configureSqliteConnectionPragmas(db, {
          databasePath: dbPath,
          foreignKeys: true,
          synchronous: "NORMAL",
        });
        try {
          expect(db.prepare("SELECT value FROM payload").all()).toEqual([{ value: "committed" }]);
          expect(vi.getTimerCount()).toBe(1);
        } finally {
          maintenance.close();
        }
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        db.close();
        vi.clearAllTimers();
      }
    },
  );

  it("retains the pragma failure when maintenance cleanup also throws", () => {
    vi.useFakeTimers();
    const dbPath = path.join(tempDirs.make("openclaw-sqlite-pragma-cleanup-"), "state.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(dbPath);
    const failure = new Error("connection pragma failed");
    const checkpointFailure = new Error("checkpoint failed");
    const reportFailure = new Error("checkpoint error reporting failed");
    try {
      const exec = db.exec.bind(db);
      vi.spyOn(db, "exec").mockImplementation((sql) => {
        if (sql === "PRAGMA foreign_keys = ON;") {
          throw failure;
        }
        exec(sql);
      });
      const prepare = db.prepare.bind(db);
      vi.spyOn(db, "prepare").mockImplementation((sql) => {
        if (sql.startsWith("PRAGMA wal_checkpoint")) {
          throw checkpointFailure;
        }
        return prepare(sql);
      });
      let caught: unknown;
      try {
        configureSqliteConnectionPragmas(db, {
          databasePath: dbPath,
          foreignKeys: true,
          onCheckpointError: () => {
            throw reportFailure;
          },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AggregateError);
      expect(caught).toMatchObject({ cause: failure, errors: [failure, reportFailure] });
      expect(vi.getTimerCount()).toBe(0);
      expect(db.isOpen).toBe(true);
    } finally {
      db.close();
      vi.clearAllTimers();
    }
  });
});
