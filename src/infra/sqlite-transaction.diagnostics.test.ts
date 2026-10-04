import { isMainThread, threadId } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "./node-sqlite.js";
import { withSqliteReaderOwner } from "./sqlite-reader-lifecycle.js";
import {
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
} from "./sqlite-transaction.js";
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
  it.each([false, true])(
    "separates preparation, SQL, host wait and COMMIT (failure: %s)",
    (failCommit) => {
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
          if (failCommit) {
            throw new Error("commit failed");
          }
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
        if (failCommit) {
          expect(run).toThrow("commit failed");
        } else {
          run();
        }
        expect(readEntries(db)).toEqual(failCommit ? [] : ["committed"]);
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
              commitMs: 500,
            },
          }),
        );
      } finally {
        admission.finish();
      }
    },
  );

  it.each(["explicit", "inherited", "unlabeled"] as const)(
    "logs one structured warning for a terminal lock failure (%s labels)",
    (labels) => {
      const execCalls: string[] = [];
      const logger = { warn: vi.fn() };
      let now = 0;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const lockError = Object.assign(new Error("database is locked"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 5,
      });
      const db = {
        location: () => "/synthetic/agent.sqlite",
        exec(sql: string) {
          execCalls.push(sql);
          if (sql === "BEGIN IMMEDIATE") {
            now += 7;
            throw lockError;
          }
        },
      } as import("node:sqlite").DatabaseSync;

      let thrown: unknown;
      try {
        const run = () =>
          runSqliteImmediateTransactionSync(db, () => "blocked", {
            busyTimeoutMs: 5_000,
            logger,
            ...(labels === "explicit"
              ? { databaseLabel: "agent.sqlite", operationLabel: "session.patch" }
              : {}),
          });
        if (labels === "unlabeled") {
          run();
        } else {
          withSqliteReaderOwner({ operation: "worker.patch", ownerKind: "worker" }, run);
        }
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(lockError);
      expect(execCalls).toEqual(["BEGIN IMMEDIATE"]);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        "SQLite transaction lock wait failed",
        expect.objectContaining({
          async: false,
          busyTimeoutMs: 5_000,
          code: "ERR_SQLITE_ERROR",
          database: labels === "explicit" ? "agent.sqlite" : "/synthetic/agent.sqlite",
          elapsedMs: 7,
          beginAdmission: { nativeAttempts: 1, nativeMs: 7, serviceCalls: 0, serviceMs: 0 },
          failureKind: "lock-contention",
          isMainThread,
          operation:
            labels === "explicit"
              ? "session.patch"
              : labels === "inherited"
                ? "worker.patch"
                : "unlabeled",
          pid: process.pid,
          sqliteErrcode: 5,
          sqlitePrimaryCode: 5,
          step: "begin",
          threadId,
        }),
      );
    },
  );

  it.each([
    { mode: "immediate", busyTimeoutMs: 0, elapsedMs: 5 },
    { mode: "immediate", busyTimeoutMs: 5_000, elapsedMs: 1_500 },
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
          ...(mode === "immediate"
            ? {
                beginAdmission: {
                  nativeAttempts: 1,
                  nativeMs: 1_500,
                  serviceCalls: 0,
                  serviceMs: 0,
                },
              }
            : {}),
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

  it.each([false, true])(
    "names a slow failed transaction holder (rollback fails: %s)",
    (rollbackFails) => {
      const logger = { warn: vi.fn() };
      let now = 0;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const db = createDatabase();
      if (rollbackFails) {
        const exec = db.exec.bind(db);
        vi.spyOn(db, "exec").mockImplementation((sql) => {
          if (sql === "ROLLBACK") {
            throw new Error("rollback failed");
          }
          exec(sql);
        });
      }
      expect(() =>
        runSqliteImmediateTransactionSync(
          db,
          () => {
            now += 5_100;
            throw new Error("rejected mutation");
          },
          {
            ...(rollbackFails ? {} : { databaseLabel: "agent.sqlite" }),
            operationLabel: "session.write",
            logger,
          },
        ),
      ).toThrow("rejected mutation");
      expect(db.isOpen).toBe(!rollbackFails);
      if (!rollbackFails) {
        expect(db.isTransaction).toBe(false);
      }
      expect(logger.warn).toHaveBeenCalledWith(
        "slow SQLite transaction hold",
        expect.objectContaining({
          database: rollbackFails ? "unavailable" : "agent.sqlite",
          elapsedMs: 5_100,
          isMainThread,
          mode: "immediate",
          operation: "session.write",
        }),
      );
    },
  );
});
