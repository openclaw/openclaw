import { isMainThread, threadId } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { observeConnection } from "./database-engine/observation.js";
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

function asWorker(
  operation: string,
  run: () => unknown,
  holdContext?: Parameters<typeof withSqliteReaderOwner>[2],
) {
  return withSqliteReaderOwner({ operation, ownerKind: "worker" }, run, holdContext);
}

const thread = { isMainThread, pid: process.pid, threadId };

it("names the admitted writer in a contending BEGIN and clears it after rollback", () => {
  const filename = resources.file();
  const holder = resources.open(filename, {}, true);
  holder.exec("CREATE TABLE entries (id TEXT)");
  const waiter = resources.open(filename, {}, true);
  waiter.exec("PRAGMA busy_timeout = 0");
  const advance = sqliteDiagnosticClock();
  const logger = { warn: vi.fn() };
  const attempt = () =>
    runSqliteImmediateTransactionSync(waiter, () => {}, {
      operationLabel: "pluginState.register",
      logger,
    });
  expect(() =>
    runSqliteImmediateTransactionSync(
      holder,
      () => {
        advance(1_500);
        expect(attempt).toThrow(/locked/);
        expect(logger.warn).toHaveBeenCalledWith(
          "SQLite transaction lock wait failed",
          expect.objectContaining({
            operation: "pluginState.register",
            holderAtWaitStart: {
              operation: "localWorkspace.pruneLegacy",
              threadId,
              heldMs: 1_500,
            },
          }),
        );
        throw new Error("rollback held writer");
      },
      { operationLabel: "localWorkspace.pruneLegacy", logger: { warn() {} } },
    ),
  ).toThrow("rollback held writer");
  logger.warn.mockClear();
  spySqliteExec(waiter, (sql) => {
    if (sql === "BEGIN IMMEDIATE") {
      advance(1_100);
    }
  });
  attempt();
  expect(logger.warn).toHaveBeenCalledWith(
    "slow SQLite transaction step",
    expect.not.objectContaining({ holderAtWaitStart: expect.anything() }),
  );
});

it("attributes slow deletion statements without counting iterator consumers or exposing SQL", () => {
  const { db, advance, run, warning, logger } = fixture();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  db.function("synthetic_elapsed", () => {
    advance(100);
    return 1;
  });
  observeConnection(db);
  const statement = db.prepare("SELECT synthetic_elapsed(), ? AS private_identifier");
  run(
    () => {
      statement.get("private-binding");
      statement.get("another-binding");
      for (const row of db
        .prepare("SELECT synthetic_elapsed() UNION ALL SELECT synthetic_elapsed()")
        .iterate()) {
        expect(row).toBeDefined();
        advance(300);
      }
      advance(400);
    },
    { operationLabel: "session.lifecycle.delete" },
  );
  warning("hold", {
    elapsedMs: 1_400,
    phases: expect.objectContaining({
      sqlMs: 1_400,
      statementExecutionMs: 400,
      callbackOtherMs: 1_000,
    }),
    statementTiming: {
      count: 3,
      maxMs: 200,
      slowest: { id: expect.stringMatching(/^[a-f0-9]{16}$/), operation: "SELECT", maxMs: 200 },
      statements: [
        {
          id: expect.stringMatching(/^[a-f0-9]{16}$/),
          operation: "SELECT",
          count: 2,
          totalMs: 200,
          maxMs: 100,
        },
        {
          id: expect.stringMatching(/^[a-f0-9]{16}$/),
          operation: "SELECT",
          count: 1,
          totalMs: 200,
          maxMs: 200,
        },
      ],
    },
  });
  expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(
    /private|synthetic_elapsed|UNION|binding/,
  );
});

it("bounds deletion statement attribution and releases it after a failed callback", () => {
  const { db, advance, run, logger } = fixture();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  db.function("synthetic_elapsed", () => {
    advance(10);
    return 1;
  });
  observeConnection(db);
  expect(() =>
    run(
      () => {
        for (let index = 0; index < 40; index++) {
          db.prepare(`SELECT synthetic_elapsed() AS column_${index}`).get();
        }
        advance(800);
        throw new Error("synthetic rejection");
      },
      { operationLabel: "session.lifecycle.delete" },
    ),
  ).toThrow("synthetic rejection");
  const hold = logger.warn.mock.calls.find(
    ([message]) => message === "slow SQLite transaction hold",
  )?.[1];
  expect(hold).toMatchObject({
    phases: { statementExecutionMs: 400, callbackOtherMs: 800 },
    statementTiming: { count: 40, maxMs: 10, statements: expect.any(Array) },
  });
  expect(hold.statementTiming.statements).toHaveLength(33);
  expect(hold.statementTiming.statements.at(-1)).toEqual({
    id: "other",
    operation: "OTHER",
    count: 8,
    totalMs: 80,
    maxMs: 10,
  });
  logger.warn.mockClear();
  run(() => advance(1_200), { operationLabel: "session.actor" });
  expect(logger.warn.mock.calls[0]?.[1]).not.toHaveProperty("statementTiming");
  logger.warn.mockClear();
  run(() => db.prepare("SELECT synthetic_elapsed()").get(), {
    operationLabel: "session.lifecycle.delete",
  });
  expect(logger.warn).not.toHaveBeenCalled();
});

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
    const holdContext = { selector: "idempotency", outcome: "incomplete", rowsVisited: 0 };
    asWorker(
      "worker.entries",
      () =>
        run(
          () => {
            db.prepare("INSERT INTO entries VALUES ('committed', 'value')").run();
            diagnosticContext.rows = 1;
            holdContext.rowsVisited = 1;
            holdContext.outcome = "hit";
            advance(elapsedMs);
          },
          {
            busyTimeoutMs,
            diagnosticContext,
            ...(elapsedMs === 5 ? {} : { slowTransactionHoldMs: 0 }),
          },
        ),
      holdContext,
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
      context: { sessionId: "session-diagnostics", rows: 1, ...holdContext },
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
