import { isMainThread, threadId } from "node:worker_threads";
import { expect, it, vi } from "vitest";
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
  type SqliteTransactionOptions,
} from "./sqlite-transaction.js";
import { exchangeSqliteDatabaseAdmissions } from "./sqlite-worker-database-admission-relay.js";
import {
  createSqliteWorkerOperationAdmission,
  requestSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";

const resources = sqliteMaintenanceFixture();
const throwingLogger = () => ({
  warn: vi.fn(() => {
    throw new Error("diagnostics failed");
  }),
});

function fixture(mode: "immediate" | "deferred" = "immediate") {
  const db = resources.entries();
  const logger = { warn: vi.fn() };
  const advance = sqliteDiagnosticClock();
  const transaction =
    mode === "immediate" ? runSqliteImmediateTransactionSync : runSqliteDeferredTransactionSync;
  const run = (operation: () => unknown, options: SqliteTransactionOptions = {}) =>
    transaction(db, operation, { logger, ...options });
  const warning = (kind: "step" | "hold", details: object) =>
    expect(logger.warn).toHaveBeenCalledWith(
      `slow SQLite transaction ${kind}`,
      expect.objectContaining(details),
    );
  return { db, logger, advance, run, warning };
}

function asWorker(operation: string, run: () => unknown) {
  return withSqliteReaderOwner({ operation, ownerKind: "worker" }, run);
}

const thread = { isMainThread, pid: process.pid, threadId };

it.each(["callback", "commit"])("attributes a metadata relay wait during %s", (stage) => {
  const { db, advance, run, warning } = fixture();
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
  asWorker("session.actor.appendTranscriptEvent", () =>
    run(() => {
      if (stage === "callback") {
        exchangeSqliteDatabaseAdmissions(admission.port, []);
      }
      db.prepare("INSERT INTO entries VALUES ('appended', 'tiny')").run();
      advance(7);
    }),
  );
  expect(readEntries(db)).toEqual(["appended"]);
  warning("hold", {
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
  const db = resources.entries();
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
  const { db, advance, run, warning } = fixture();
  const admission = createSqliteWorkerOperationAdmission((_request, grant) => {
    advance(350);
    grant();
  });
  resources.retain(() => admission.finish());
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
  const attempt = () =>
    asWorker("state.lease.renew", () => {
      advance(200);
      return withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
        run(
          () => {
            requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: null });
            db.prepare("INSERT INTO entries VALUES ('committed', 'value')").run();
            advance(50);
          },
          {
            withCommit(commit) {
              requestSqliteWorkerOperationAdmission({ stage: "commit", facts: null });
              commit();
            },
          },
        ),
      );
    });
  expect(attempt).toThrow("commit failed");
  expectSettledEntries(db, []);
  warning("hold", {
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
    const { db, logger, advance, run, warning } = fixture(mode);
    const location = vi.spyOn(db, "location");
    spySqliteExec(db, undefined, () => advance(elapsedMs));

    const diagnosticContext = { sessionId: "session-diagnostics", rows: 0 };
    asWorker("worker.entries", () =>
      run(
        () => {
          db.prepare("INSERT INTO entries VALUES ('committed', 'value')").run();
          diagnosticContext.rows = 1;
          advance(elapsedMs);
        },
        {
          busyTimeoutMs,
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
    warning("step", {
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
    warning("hold", {
      ...labels,
      elapsedMs: 3_000,
      mode,
      context: { sessionId: "session-diagnostics", rows: 1 },
    });
  },
);

it.each(["immediate", "deferred"] as const)(
  "preserves successful %s transactions when warnings throw",
  (mode) => {
    const { db, advance, run } = fixture(mode);
    const execSpy = spySqliteExec(db, undefined, () => advance(1_500));
    const logger = throwingLogger();
    const withCommit = vi.fn((commit: () => void) => commit());
    expect(
      run(
        () => {
          expect(db.isTransaction).toBe(true);
          db.prepare("INSERT INTO entries VALUES ('committed', 'value')").run();
          return "committed";
        },
        { logger, withCommit },
      ),
    ).toBe("committed");
    expect(logger.warn).toHaveBeenCalledWith(
      "slow SQLite transaction step",
      expect.objectContaining({ step: "commit" }),
    );
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
    const logger = throwingLogger();
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
  const { db, advance, run, warning } = fixture();
  spySqliteExec(db, (sql) => {
    if (sql === "ROLLBACK") {
      throw new Error("rollback failed");
    }
  });
  expect(() =>
    run(
      () => {
        advance(5_100);
        throw new Error("rejected mutation");
      },
      { operationLabel: "session.write" },
    ),
  ).toThrow("rejected mutation");
  expect(db.isOpen).toBe(false);
  warning("hold", {
    database: "unavailable",
    elapsedMs: 5_100,
    isMainThread,
    mode: "immediate",
    operation: "session.write",
  });
});
