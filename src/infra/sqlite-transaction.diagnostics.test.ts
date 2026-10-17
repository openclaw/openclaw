import { isMainThread, threadId } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import {
  expectSettledEntries,
  readEntryIds as readEntries,
  sqliteDiagnosticClock,
  sqliteMaintenanceFixture,
  spySqliteExec,
  thrownBy,
} from "./sqlite-maintenance-fixture.test-support.js";
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

const resources = sqliteMaintenanceFixture();
const createDatabase = resources.entries;

function fixture() {
  return { db: createDatabase(), logger: { warn: vi.fn() }, advance: sqliteDiagnosticClock() };
}

function expectWarning(
  logger: { warn: ReturnType<typeof vi.fn> },
  kind: "step" | "hold",
  details: object,
) {
  expect(logger.warn).toHaveBeenCalledWith(
    `slow SQLite transaction ${kind}`,
    expect.objectContaining(details),
  );
}

const thread = { isMainThread, pid: process.pid, threadId };

describe("SQLite transaction diagnostics", () => {
  it.each(["callback", "commit"])("attributes a metadata relay wait during %s", (stage) => {
    const { db, logger, advance } = fixture();
    const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
    resources.retain(() => admission.finish());
    vi.spyOn(Atomics, "wait").mockImplementation(() => {
      expect(db.isTransaction).toBe(true);
      advance(1_000);
      admission.service();
      return "ok";
    });
    spySqliteExec(db, (sql) => {
      if (sql === "COMMIT") {
        if (stage === "commit") {
          exchangeSqliteDatabaseAdmissions(admission.port, []);
        }
        advance(3);
      }
    });
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
            advance(7);
          },
          { logger },
        ),
    );
    expect(readEntries(db)).toEqual(["appended"]);
    expectWarning(logger, "hold", {
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
    });
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
    expectSettledEntries(db, []);
  });

  it("separates preparation, SQL, host wait and a failed COMMIT", () => {
    const { db, logger, advance } = fixture();
    const admission = createSqliteWorkerOperationAdmission((_request, grant) => {
      advance(350);
      grant();
    });
    resources.retain(() => admission.finish());
    // Service the real private port at the native wait, without sleeping.
    vi.spyOn(Atomics, "wait").mockImplementation(() => {
      admission.service();
      return "ok";
    });
    spySqliteExec(db, (sql) => {
      if (sql === "BEGIN IMMEDIATE") {
        advance(100);
      }
      if (sql === "COMMIT") {
        advance(500);
        throw new Error("commit failed");
      }
    });
    const run = () =>
      withSqliteReaderOwner({ operation: "state.lease.renew", ownerKind: "worker" }, () => {
        advance(200);
        return withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
          runSqliteImmediateTransactionSync(
            db,
            () => {
              requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: null });
              db.prepare("INSERT INTO entries VALUES ('committed', 'value')").run();
              advance(50);
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
    expectSettledEntries(db, []);
    expectWarning(logger, "hold", {
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
    });
  });

  it.each([
    { mode: "immediate", busyTimeoutMs: 0, elapsedMs: 5 },
    { mode: "deferred", busyTimeoutMs: 0, elapsedMs: 1_500 },
  ] as const)(
    "reports successful $mode steps at $elapsedMs ms with busyTimeoutMs=$busyTimeoutMs",
    ({ mode, busyTimeoutMs, elapsedMs }) => {
      const { db, logger, advance } = fixture();
      const location = vi.spyOn(db, "location");
      spySqliteExec(db, undefined, () => advance(elapsedMs));

      const run =
        mode === "immediate" ? runSqliteImmediateTransactionSync : runSqliteDeferredTransactionSync;
      const diagnosticContext = { sessionId: "session-diagnostics", rows: 0 };
      withSqliteReaderOwner({ operation: "worker.entries", ownerKind: "worker" }, () =>
        run(
          db,
          () => {
            db.prepare("INSERT INTO entries VALUES ('committed', 'value')").run();
            diagnosticContext.rows = 1;
            advance(elapsedMs);
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

      const labels = { ...thread, async: false, database: ":memory:", operation: "worker.entries" };
      expectWarning(logger, "step", {
        ...labels,
        elapsedMs: 1_500,
        context: { sessionId: "session-diagnostics", rows: 0 },
        step: "begin",
      });
      expect(logger.warn).toHaveBeenCalledWith("slow SQLite transaction step", {
        ...labels,
        busyTimeoutMs,
        elapsedMs: 1_500,
        context: { sessionId: "session-diagnostics", rows: 1 },
        step: "commit",
      });
      expectWarning(logger, "hold", {
        ...labels,
        elapsedMs: 3_000,
        mode,
        context: { sessionId: "session-diagnostics", rows: 1 },
      });
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
      const advance = sqliteDiagnosticClock();
      const execSpy = spySqliteExec(db, undefined, () => advance(1_500));
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
      expectSettledEntries(db, ["committed"]);
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
    (step) => {
      const databasePath = resources.file();
      const db = resources.open(databasePath);
      const blocker = resources.open(databasePath);
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
      const thrown = thrownBy(() => runSqliteImmediateTransactionSync(db, operation, { logger }));
      expect(nativeError).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 5 });
      expect(thrown).toBe(nativeError);
      expectSettledEntries(db, []);
      expect(operation).toHaveBeenCalledTimes(step === "begin" ? 0 : 1);
      expect(execSpy.mock.calls.map(([sql]) => sql)).toEqual(
        step === "begin" ? ["BEGIN IMMEDIATE"] : ["BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"],
      );
      expect(logger.warn).toHaveBeenCalledTimes(1);
    },
  );

  it("names a slow failed transaction holder after rollback closes its connection", () => {
    const { db, logger, advance } = fixture();
    spySqliteExec(db, (sql) => {
      if (sql === "ROLLBACK") {
        throw new Error("rollback failed");
      }
    });
    expect(() =>
      runSqliteImmediateTransactionSync(
        db,
        () => {
          advance(5_100);
          throw new Error("rejected mutation");
        },
        {
          operationLabel: "session.write",
          logger,
        },
      ),
    ).toThrow("rejected mutation");
    expect(db.isOpen).toBe(false);
    expectWarning(logger, "hold", {
      database: "unavailable",
      elapsedMs: 5_100,
      isMainThread,
      mode: "immediate",
      operation: "session.write",
    });
  });
});
