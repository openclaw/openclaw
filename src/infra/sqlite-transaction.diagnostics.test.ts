import path from "node:path";
import { isMainThread, threadId } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { withSqliteReaderOwner } from "./sqlite-reader-lifecycle.js";
import {
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
  runSqliteWorkerTransactionSync,
} from "./sqlite-transaction.js";
import { exchangeSqliteDatabaseAdmissions } from "./sqlite-worker-database-admission-relay.js";
import {
  createSqliteWorkerOperationAdmission,
  requestSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";

const openDatabases: Array<import("node:sqlite").DatabaseSync> = [];

function createDatabase(): import("node:sqlite").DatabaseSync {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE entries (id TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL)");
  openDatabases.push(db);
  return db;
}

function readEntries(db: import("node:sqlite").DatabaseSync) {
  return db
    .prepare("SELECT id FROM entries ORDER BY id")
    .all()
    .map((row) => row.id);
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    if (db.isOpen) {
      db.close();
    }
  }
  vi.restoreAllMocks();
});

describe("SQLite transaction diagnostics", () => {
  it.each(["callback", "commit"])("attributes a metadata relay wait during %s", (stage) => {
    const db = createDatabase();
    const logger = { warn: vi.fn() };
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
    vi.spyOn(Atomics, "wait").mockImplementation(() => {
      expect(db.isTransaction).toBe(true);
      now += 1_000;
      admission.service();
      return "ok";
    });
    const exec = db.exec.bind(db);
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "COMMIT") {
        if (stage === "commit") {
          exchangeSqliteDatabaseAdmissions(admission.port, []);
        }
        now += 3;
      }
      exec(sql);
    });
    try {
      withSqliteReaderOwner(
        { operation: "session.actor.appendTranscriptEvent", ownerKind: "worker" },
        () =>
          runSqliteImmediateTransactionSync(
            db,
            () => {
              if (stage === "callback") {
                exchangeSqliteDatabaseAdmissions(admission.port, []);
              }
              db.prepare("INSERT INTO entries VALUES ('appended', 'tiny')").run();
              now += 7;
            },
            { logger },
          ),
      );
      expect(readEntries(db)).toEqual(["appended"]);
      expect(logger.warn).toHaveBeenCalledWith(
        "slow SQLite transaction hold",
        expect.objectContaining({
          callbackKind: "application-transaction",
          elapsedMs: 1_010,
          phases: {
            prepareMs: 0,
            beginMs: 0,
            sqlMs: 7,
            hostAdmissionWaitMs: 0,
            databaseAdmissionWaitMs: 1_000,
            commitMs: 3,
          },
        }),
      );
    } finally {
      admission.finish();
    }
  });

  it("waits for transaction admission before BEGIN and still refuses a revoked commit", () => {
    const db = createDatabase();
    const phases: Array<[string, boolean]> = [];
    expect(() =>
      runSqliteWorkerTransactionSync(
        {
          database: db,
          databasePath: ":memory:",
          admit(stage) {
            phases.push([stage, db.isTransaction]);
            if (stage === "commit") {
              throw new Error("authority revoked");
            }
          },
        },
        () => db.prepare("INSERT INTO entries VALUES ('refused', 'value')").run(),
      ),
    ).toThrow("authority revoked");
    expect(phases).toEqual([
      ["transaction", false],
      ["commit", true],
    ]);
    expect(readEntries(db)).toEqual([]);
    expect(db.isTransaction).toBe(false);
  });

  it("separates preparation, SQL, host wait and a failed COMMIT", () => {
    const db = createDatabase();
    const logger = { warn: vi.fn() };
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const admission = createSqliteWorkerOperationAdmission((_request, grant) => {
      now += 350;
      grant();
    });
    // Service the real private port at the native wait, without sleeping.
    vi.spyOn(Atomics, "wait").mockImplementation(() => {
      admission.service();
      return "ok";
    });
    const exec = db.exec.bind(db);
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "BEGIN IMMEDIATE") {
        now += 100;
      }
      if (sql === "COMMIT") {
        now += 500;
        throw new Error("commit failed");
      }
      exec(sql);
    });
    try {
      const run = () =>
        withSqliteReaderOwner({ operation: "state.lease.renew", ownerKind: "worker" }, () => {
          now += 200;
          return withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
            runSqliteImmediateTransactionSync(
              db,
              () => {
                requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: null });
                db.prepare("INSERT INTO entries VALUES ('committed', 'value')").run();
                now += 50;
              },
              {
                logger,
                withCommit(commit) {
                  requestSqliteWorkerOperationAdmission({ stage: "commit", facts: null });
                  commit();
                },
              },
            ),
          );
        });
      expect(run).toThrow("commit failed");
      expect(readEntries(db)).toEqual([]);
      expect(db.isTransaction).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        "slow SQLite transaction hold",
        expect.objectContaining({
          operation: "state.lease.renew",
          elapsedMs: 1_250,
          phases: {
            prepareMs: 200,
            beginMs: 100,
            sqlMs: 50,
            hostAdmissionWaitMs: 700,
            databaseAdmissionWaitMs: 0,
            commitMs: 500,
          },
        }),
      );
    } finally {
      admission.finish();
    }
  });

  it.each([
    { mode: "immediate", busyTimeoutMs: 0, elapsedMs: 5 },
    { mode: "deferred", busyTimeoutMs: 0, elapsedMs: 1_500 },
  ] as const)(
    "reports successful $mode steps at $elapsedMs ms with busyTimeoutMs=$busyTimeoutMs",
    ({ mode, busyTimeoutMs, elapsedMs }) => {
      const logger = { warn: vi.fn() };
      let now = 0;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const db = createDatabase();
      const location = vi.spyOn(db, "location");
      const exec = db.exec.bind(db);
      vi.spyOn(db, "exec").mockImplementation((sql) => {
        exec(sql);
        now += elapsedMs;
      });

      const run =
        mode === "immediate" ? runSqliteImmediateTransactionSync : runSqliteDeferredTransactionSync;
      const diagnosticContext = { sessionId: "session-diagnostics", rows: 0 };
      withSqliteReaderOwner({ operation: "worker.entries", ownerKind: "worker" }, () =>
        run(
          db,
          () => {
            db.prepare("INSERT INTO entries VALUES ('committed', 'value')").run();
            diagnosticContext.rows = 1;
            now += elapsedMs;
            return "committed";
          },
          {
            busyTimeoutMs,
            logger,
            diagnosticContext,
            ...(elapsedMs === 5 ? {} : { slowTransactionHoldMs: 0 }),
          },
        ),
      );
      expect(readEntries(db)).toEqual(["committed"]);
      if (elapsedMs === 5) {
        // Zero busy timeout must retain the default slow-step threshold.
        expect(logger.warn).not.toHaveBeenCalled();
        expect(location).not.toHaveBeenCalled();
        return;
      }

      expect(logger.warn).toHaveBeenCalledWith(
        "slow SQLite transaction step",
        expect.objectContaining({
          async: false,
          database: ":memory:",
          elapsedMs: 1_500,
          isMainThread,
          operation: "worker.entries",
          context: { sessionId: "session-diagnostics", rows: 0 },
          pid: process.pid,
          step: "begin",
          threadId,
        }),
      );
      expect(logger.warn).toHaveBeenCalledWith("slow SQLite transaction step", {
        async: false,
        busyTimeoutMs,
        database: ":memory:",
        elapsedMs: 1_500,
        isMainThread,
        operation: "worker.entries",
        context: { sessionId: "session-diagnostics", rows: 1 },
        pid: process.pid,
        step: "commit",
        threadId,
      });
      expect(logger.warn).toHaveBeenCalledWith(
        "slow SQLite transaction hold",
        expect.objectContaining({
          async: false,
          database: ":memory:",
          elapsedMs: 3_000,
          isMainThread,
          mode,
          operation: "worker.entries",
          context: { sessionId: "session-diagnostics", rows: 1 },
          pid: process.pid,
          threadId,
        }),
      );
    },
  );

  it.each([
    { mode: "immediate", warningPolicy: "all" },
    { mode: "deferred", warningPolicy: "all" },
    { mode: "immediate", warningPolicy: "commit-only" },
    { mode: "deferred", warningPolicy: "commit-only" },
  ] as const)(
    "preserves successful $mode transactions when $warningPolicy warnings throw",
    ({ mode, warningPolicy }) => {
      const db = createDatabase();
      let now = 0;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const exec = db.exec.bind(db);
      const execSpy = vi.spyOn(db, "exec").mockImplementation((sql) => {
        exec(sql);
        now += 1_500;
      });
      let commitWarningObserved = false;
      const logger = {
        warn: vi.fn((message: string, meta?: Record<string, unknown>) => {
          const isCommitWarning =
            message === "slow SQLite transaction step" && meta?.step === "commit";
          if (isCommitWarning) {
            commitWarningObserved = true;
          }
          if (warningPolicy === "all" || isCommitWarning) {
            throw new Error("diagnostics failed");
          }
        }),
      };
      const withCommit = vi.fn((commit: () => void) => commit());
      const run =
        mode === "immediate" ? runSqliteImmediateTransactionSync : runSqliteDeferredTransactionSync;
      expect(
        run(
          db,
          () => {
            expect(db.isTransaction).toBe(true);
            db.prepare("INSERT INTO entries VALUES ('committed', 'value')").run();
            return "committed";
          },
          { logger, withCommit },
        ),
      ).toBe("committed");
      expect(commitWarningObserved).toBe(true);
      expect(db.isTransaction).toBe(false);
      expect(readEntries(db)).toEqual(["committed"]);
      expect(withCommit).toHaveBeenCalledTimes(1);
      expect(execSpy.mock.calls.map(([sql]) => sql)).toEqual([
        mode === "immediate" ? "BEGIN IMMEDIATE" : "BEGIN",
        "COMMIT",
      ]);
      expect(logger.warn).toHaveBeenCalledTimes(3);
    },
  );

  it.each(["begin", "commit"] as const)(
    "preserves the native %s lock failure when its warning throws",
    async (step) => {
      await withTestDir({ prefix: "openclaw-sqlite-diagnostics-" }, async (dir) => {
        const { DatabaseSync } = requireNodeSqlite();
        const databasePath = path.join(dir, "locked.sqlite");
        const db = new DatabaseSync(databasePath);
        const blocker = new DatabaseSync(databasePath);
        try {
          db.exec("PRAGMA busy_timeout = 0; CREATE TABLE entries (id TEXT PRIMARY KEY)");
          blocker.exec(step === "begin" ? "BEGIN IMMEDIATE" : "BEGIN");
          if (step === "commit") {
            blocker.prepare("SELECT id FROM entries").all();
          }
          let nativeError: unknown;
          const exec = db.exec.bind(db);
          const execSpy = vi.spyOn(db, "exec").mockImplementation((sql) => {
            try {
              exec(sql);
            } catch (error) {
              nativeError = error;
              throw error;
            }
          });
          const logger = {
            warn: vi.fn(() => {
              throw new Error("diagnostics failed");
            }),
          };
          const operation = vi.fn(() => {
            db.prepare("INSERT INTO entries VALUES ('uncommitted')").run();
          });
          let thrown: unknown;
          try {
            runSqliteImmediateTransactionSync(db, operation, { logger });
          } catch (error) {
            thrown = error;
          }
          expect(nativeError).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 5 });
          expect(thrown).toBe(nativeError);
          expect(db.isTransaction).toBe(false);
          expect(readEntries(db)).toEqual([]);
          expect(operation).toHaveBeenCalledTimes(step === "begin" ? 0 : 1);
          expect(execSpy.mock.calls.map(([sql]) => sql)).toEqual(
            step === "begin" ? ["BEGIN IMMEDIATE"] : ["BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"],
          );
          expect(logger.warn).toHaveBeenCalledTimes(1);
        } finally {
          blocker.close();
          db.close();
        }
      });
    },
  );

  it("names a slow failed transaction holder after rollback closes its connection", () => {
    const logger = { warn: vi.fn() };
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const db = createDatabase();
    const exec = db.exec.bind(db);
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "ROLLBACK") {
        throw new Error("rollback failed");
      }
      exec(sql);
    });
    expect(() =>
      runSqliteImmediateTransactionSync(
        db,
        () => {
          now += 5_100;
          throw new Error("rejected mutation");
        },
        {
          operationLabel: "session.write",
          logger,
        },
      ),
    ).toThrow("rejected mutation");
    expect(db.isOpen).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      "slow SQLite transaction hold",
      expect.objectContaining({
        database: "unavailable",
        elapsedMs: 5_100,
        isMainThread,
        mode: "immediate",
        operation: "session.write",
      }),
    );
  });
});
