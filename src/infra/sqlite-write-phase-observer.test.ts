import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import {
  createSqliteWritePhaseRecorder,
  recordSqliteWritePhase,
  sqliteWritePhaseLogFields,
  withSqliteWritePhaseObserver,
} from "./sqlite-write-phase-observer.js";

function clockedRecorder() {
  let clock = 100;
  const recorder = createSqliteWritePhaseRecorder(clock, () => clock);
  return {
    recorder,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("partitions one grant into lease, open, schema, mutation, commit and release", () => {
  const { recorder, advance } = clockedRecorder();
  advance(5);
  recorder.record({ kind: "phase", phase: "lease-prepare" });
  advance(10);
  recorder.record({ kind: "phase", phase: "open" });
  advance(20);
  recorder.record({ kind: "phase", phase: "schema" });
  advance(1);
  recorder.record({ kind: "transaction", step: "begin" });
  advance(300);
  recorder.record({ kind: "transaction", step: "commit-start" });
  advance(7);
  recorder.record({ kind: "transaction", step: "commit-end" });
  advance(2);
  const report = recorder.finish();
  expect(report.totalsMs).toEqual({
    "lease-prepare": 5,
    open: 10,
    schema: 20,
    mutation: 301,
    commit: 7,
    release: 2,
  });
  expect(report.nativeTransactionMs).toBe(307);
  expect(report.nativeTransactions).toBe(1);
  expect(report.nativeTransactionOpenAtEnd).toBe(false);
  expect(report.spans).toEqual([
    { phase: "lease-prepare", startMs: 100, endMs: 105, nativeTransaction: false },
    { phase: "open", startMs: 105, endMs: 115, nativeTransaction: false },
    { phase: "schema", startMs: 115, endMs: 135, nativeTransaction: false },
    { phase: "mutation", startMs: 135, endMs: 136, nativeTransaction: false },
    { phase: "mutation", startMs: 136, endMs: 436, nativeTransaction: true },
    { phase: "commit", startMs: 436, endMs: 443, nativeTransaction: true },
    { phase: "release", startMs: 443, endMs: 445, nativeTransaction: false },
  ]);
  // Late events after release cannot rewrite the settled report.
  recorder.record({ kind: "phase", phase: "open" });
  expect(recorder.finish()).toBe(report);
});

test("reports a transaction still open at release and bounds the span list", () => {
  const { recorder, advance } = clockedRecorder();
  for (let index = 0; index < 40; index += 1) {
    advance(1);
    recorder.record({ kind: "phase", phase: index % 2 ? "open" : "schema" });
  }
  recorder.record({ kind: "transaction", step: "begin" });
  advance(3);
  const report = recorder.finish();
  expect(report.spans).toHaveLength(32);
  expect(report.droppedSpans).toBe(10);
  expect(report.totalsMs.open + report.totalsMs.schema).toBe(40);
  expect(report.totalsMs.release).toBe(3);
  expect(report.nativeTransactionOpenAtEnd).toBe(true);
});

test("log fields extend release to the owner's observed release", () => {
  const { recorder, advance } = clockedRecorder();
  advance(4);
  recorder.record({ kind: "transaction", step: "begin" });
  advance(6);
  recorder.record({ kind: "transaction", step: "rollback" });
  advance(1);
  const fields = sqliteWritePhaseLogFields({
    report: recorder.finish(),
    grantedAtMs: 98.5,
    releasedAtMs: 120,
  });
  expect(fields).toEqual({
    phasesMs: { "lease-prepare": 0, open: 0, schema: 0, mutation: 10, commit: 0, release: 10 },
    grantTransitMs: 1.5,
    nativeTransactionMs: 6,
    nativeTransactions: 1,
    nativeTransactionOpenAtRelease: false,
    spans: [
      { phase: "mutation", startMs: 100, endMs: 104, nativeTransaction: false },
      { phase: "mutation", startMs: 104, endMs: 110, nativeTransaction: true },
      { phase: "release", startMs: 110, endMs: 120, nativeTransaction: false },
    ],
  });
});

test("native transactions report only to the innermost scoped grant", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE t (v INTEGER)");
    // Unscoped native writes are not observed.
    recordSqliteWritePhase({ kind: "phase", phase: "open" });
    runSqliteImmediateTransactionSync(db, () => db.exec("INSERT INTO t VALUES (1)"));
    const recorder = createSqliteWritePhaseRecorder();
    withSqliteWritePhaseObserver(recorder, () => {
      runSqliteImmediateTransactionSync(db, () => {
        db.exec("INSERT INTO t VALUES (2)");
        // Nested savepoints stay inside the outer transaction's span.
        runSqliteImmediateTransactionSync(db, () => db.exec("INSERT INTO t VALUES (3)"));
      });
      expect(() =>
        runSqliteImmediateTransactionSync(db, () => {
          db.exec("INSERT INTO t VALUES (4)");
          throw new Error("synthetic rollback");
        }),
      ).toThrow("synthetic rollback");
    });
    const report = recorder.finish();
    expect(report.nativeTransactions).toBe(2);
    expect(report.nativeTransactionOpenAtEnd).toBe(false);
    expect(report.spans.map(({ phase, nativeTransaction }) => [phase, nativeTransaction])).toEqual([
      ["mutation", false],
      ["mutation", true],
      ["commit", true],
      ["mutation", false],
      ["mutation", true],
      ["release", false],
    ]);
    expect(db.prepare("SELECT v FROM t ORDER BY v").all()).toEqual([{ v: 1 }, { v: 2 }, { v: 3 }]);
  } finally {
    db.close();
  }
});
