import { channel } from "node:diagnostics_channel";
import { expect } from "vitest";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  pruneExpiredAuditEventsInDatabase,
  recordAuditEventInDatabase,
  recordAuditRunInDatabase,
} from "./audit-event-store.js";
import type {
  AuditEventInput,
  AgentRunFinishedAuditEventInput,
  AgentRunStartedAuditEventInput,
} from "./audit-event-types.js";
import { input as runInput } from "./audit-event-writer.test-support.js";

function auditStore(database: OpenClawStateDatabase) {
  const options = { database };
  const rows = (selection: string, suffix = "", ...params: string[]) =>
    database.db.prepare(`SELECT ${selection} FROM audit_events ${suffix}`).all(...params);
  const transaction = (action: () => void) => runOpenClawStateWriteTransaction(action, options);
  return {
    options,
    rows,
    transaction,
    exec: (sql: string, ...params: number[]) =>
      transaction(() => {
        database.db.prepare(sql).run(...params);
      }),
    runs: (runId: string, order = "event_id") =>
      rows(
        "event_id, CAST(sequence AS TEXT) AS sequence",
        `WHERE run_id = ? ORDER BY ${order}`,
        runId,
      ),
    number: (expression: string, suffix = "") =>
      Number(rows(`${expression} AS value`, suffix)[0]?.value),
    sequence: (event: AuditEventInput, id?: string) =>
      recordAuditEventInDatabase(event, options, id)?.sequence,
  };
}

function seedAuditEvents(database: OpenClawStateDatabase, occurredAt: number, count: number): void {
  auditStore(database).exec(
    `WITH digits(d) AS (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
            numbers(n) AS (
              SELECT 1 + a.d + 10*b.d + 100*c.d + 1000*d.d + 10000*e.d + 100000*f.d
              FROM digits a, digits b, digits c, digits d, digits e, digits f
            )
       INSERT INTO audit_events (
         event_id, source_id, source_sequence, occurred_at, kind, action, status,
         actor_type, actor_id, agent_id, run_id
       )
       SELECT 'event-' || n, 'source-' || n, n, CAST(? AS BIGINT) + n, 'agent_run',
              'agent.run.started', 'started', 'agent', 'main', 'main', 'run-' || n
       FROM numbers WHERE n <= ? ORDER BY n`,
    occurredAt,
    count,
  );
}

function observeAuditStatements(action: () => void, includeEnvelope = false): string[] {
  const statements: string[] = [];
  const observation = channel("openclaw.database.statement");
  const observe = (event: unknown) => {
    if (event && typeof event === "object" && "sql" in event && typeof event.sql === "string") {
      if (includeEnvelope || event.sql.includes("audit_events")) {
        statements.push(event.sql);
      }
    }
  };
  observation.subscribe(observe);
  try {
    action();
  } finally {
    observation.unsubscribe(observe);
  }
  return statements;
}

export function assertAuditOverflowRetention(database: OpenClawStateDatabase): void {
  const { options, rows, number, sequence, exec } = auditStore(database);
  const occurredAt = Date.now();
  // Public retention contract: 100,000 rows, with 1,024 rows of headroom after overflow.
  const retainedRows = 100_000 - 1_024;
  seedAuditEvents(database, occurredAt, 100_008);
  // Gaps must not move the retained row boundary or reset sequence allocation.
  exec("DELETE FROM audit_events WHERE source_sequence BETWEEN 2 AND 11");
  const { start: input, finish } = auditRunInputs("overflow-run", occurredAt + 100_010, 100_010);
  expect(sequence({ ...input, sourceId: "overflow-warm", sourceSequence: 100_009 })).toBe(100_009);
  const eventIds = ["overflow-start", "overflow-finish"] as const;
  expect(
    observeAuditStatements(() => {
      recordAuditRunInDatabase(input, finish, options, eventIds);
    }),
  ).toHaveLength(3); // Insert, overflow delete, remaining expiry.
  expect([number("COUNT(*)"), number("MIN(sequence)"), number("MAX(sequence)")]).toEqual([
    retainedRows,
    1_036,
    100_011,
  ]);

  recordAuditRunInDatabase(input, finish, options, eventIds);
  expect(sequence({ ...input, sourceId: "after-overflow" })).toBe(100_014);
  expect([number("COUNT(*)"), number("MIN(sequence)")]).toEqual([retainedRows + 1, 1_036]);

  const expiry = observeAuditStatements(() => {
    recordAuditRunInDatabase(
      {
        ...input,
        sourceId: "expired-start",
        occurredAt: occurredAt - 30 * 24 * 60 * 60_000 - 1_000,
      },
      { ...finish, sourceId: "current-finish", occurredAt },
      options,
      ["expired-start", "current-finish"],
    );
  });
  expect(expiry).toHaveLength(3);
  expect(rows("event_id", "WHERE event_id IN ('expired-start', 'current-finish')")).toEqual([
    { event_id: "current-finish" },
  ]);
}

export function assertAuditRetentionCountDrift(database: OpenClawStateDatabase): void {
  const { number, sequence, exec } = auditStore(database);
  const occurredAt = Date.now();
  seedAuditEvents(database, occurredAt, 99_999);
  const { start: input } = auditRunInputs("count-drift", occurredAt);
  const write = (sourceSequence: number) =>
    sequence({ ...input, sourceId: `count-drift-${sourceSequence}`, sourceSequence });
  expect(write(1)).toBe(100_000);
  // Change durable rows without the audit owner's retention invalidation.
  exec("DELETE FROM audit_events WHERE sequence < 100000");
  expect(observeAuditStatements(() => expect(write(2)).toBe(100_001))).toHaveLength(3);
  expect(
    observeAuditStatements(() => expect([write(3), write(4)]).toEqual([100_002, 100_003])),
  ).toEqual([expect.stringMatching(/^insert /i), expect.stringMatching(/^insert /i)]);
  expect(number("COUNT(*)")).toBe(4);
}

function auditRunInputs(runId: string, occurredAt = Date.now(), sourceSequence = 1) {
  const start: AgentRunStartedAuditEventInput = {
    ...runInput(),
    runId,
    sourceId: `${runId}-start`,
    sourceSequence,
    occurredAt,
  };
  const finish: AgentRunFinishedAuditEventInput = {
    ...start,
    sourceId: `${runId}-finish`,
    sourceSequence: sourceSequence + 1,
    action: "agent.run.finished",
    status: "succeeded",
  };
  return { start, finish };
}

export function assertAuditRunWarmWrite(database: OpenClawStateDatabase): void {
  const { options, runs } = auditStore(database);
  recordAuditEventInDatabase(auditRunInputs("warm-owner").start, options);
  const { start, finish } = auditRunInputs("warm-pair");
  const statements = observeAuditStatements(() => {
    recordAuditRunInDatabase(start, finish, options, ["warm-start", "warm-finish"]);
  }, true);
  const insert = expect.stringMatching(/^insert into "audit_events" /i);
  expect(statements).toEqual(
    isPostgresSqlConnection(database.db)
      ? [
          // The existing PG owner sends BEGIN and the eager lock in one bridge request.
          expect.stringMatching(
            /^BEGIN ISOLATION LEVEL READ COMMITTED; SELECT pg_advisory_xact_lock\(/i,
          ),
          insert,
          "COMMIT",
        ]
      : [insert],
  );
  expect(runs("warm-pair", "sequence")).toEqual([
    { event_id: "warm-start", sequence: "2" },
    { event_id: "warm-finish", sequence: "3" },
  ]);
}

export function assertAuditRunReplay(database: OpenClawStateDatabase): void {
  const { options, runs, sequence } = auditStore(database);
  for (const [name, hasStart, hasFinish, sequences, nextSequence] of [
    ["whole", true, true, [1, 2], 5],
    ["start", true, false, [6, 8], 9],
    ["finish", false, true, [11, 10], 13],
  ] as const) {
    const { start, finish } = auditRunInputs(name);
    const eventIds = [`${name}-start`, `${name}-finish`] as const;
    if (hasStart) {
      recordAuditEventInDatabase(start, options, eventIds[0]);
    }
    if (hasFinish) {
      recordAuditEventInDatabase(finish, options, eventIds[1]);
    }
    if (!hasStart || !hasFinish) {
      // Real maintenance drops cached sequence facts before the partial replay.
      pruneExpiredAuditEventsInDatabase({ database: options });
    }
    recordAuditRunInDatabase(
      { ...start, sourceId: `${name}-retry-start` },
      { ...finish, sourceId: `${name}-retry-finish` },
      options,
      eventIds,
    );
    expect(runs(name)).toEqual([
      { event_id: `${name}-finish`, sequence: String(sequences[1]) },
      { event_id: `${name}-start`, sequence: String(sequences[0]) },
    ]);
    const afterReplay = observeAuditStatements(() => {
      expect(sequence({ ...start, sourceId: `${name}-after`, runId: `${name}-after` })).toBe(
        nextSequence,
      );
    });
    if (!hasStart || !hasFinish) {
      expect(afterReplay).toEqual([expect.stringMatching(/^insert /i)]);
    }
  }
}

export function assertAuditRunAtomicity(database: OpenClawStateDatabase): void {
  const { options, rows, number, sequence, transaction } = auditStore(database);
  const invalid = auditRunInputs("invalid-run");
  const rejectPair = () =>
    recordAuditRunInDatabase(invalid.start, { ...invalid.finish, actorId: "" }, options, [
      "invalid-start",
      "invalid-finish",
    ]);
  expect(rejectPair).toThrow("invalid actorId");
  expect(number("COUNT(*)")).toBe(0);

  const retained = auditRunInputs("retained-run");
  recordAuditRunInDatabase(retained.start, retained.finish, options, ["kept-start", "kept-finish"]);
  // The same invalid finish must not leave a start once the SQLite owner is warm.
  expect(rejectPair).toThrow("invalid actorId");
  const rolledBack = auditRunInputs("rolled-back-run");
  expect(() =>
    transaction(() => {
      recordAuditRunInDatabase(rolledBack.start, rolledBack.finish, options, [
        "rolled-start",
        "rolled-finish",
      ]);
      throw new Error("rollback enclosing run pair");
    }),
  ).toThrow("rollback enclosing run pair");

  const next = sequence(
    { ...retained.start, sourceId: "after-rollback", runId: "after-rollback" },
    "after-rollback",
  );
  expect(rows("event_id", "ORDER BY sequence")).toEqual([
    { event_id: "kept-start" },
    { event_id: "kept-finish" },
    { event_id: "after-rollback" },
  ]);
  // PG keeps sequence gaps after rollback; both engines must return the durable sequence.
  expect(number("sequence", "WHERE event_id = 'after-rollback'")).toBe(next);
}
