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
  AgentRunFinishedAuditEventInput,
  AgentRunStartedAuditEventInput,
  AuditEventInput,
} from "./audit-event-types.js";

function seedAuditEvents(database: OpenClawStateDatabase, occurredAt: number, count: number): void {
  runOpenClawStateWriteTransaction(
    () => {
      database.db
        .prepare(
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
        )
        .run(occurredAt, count);
    },
    { database },
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
  const { db } = database;
  const occurredAt = Date.now();
  // Public retention contract: 100,000 rows, with 1,024 rows of headroom after overflow.
  const retainedRows = 100_000 - 1_024;
  seedAuditEvents(database, occurredAt, 100_008);
  // Gaps must not move the retained row boundary or reset sequence allocation.
  runOpenClawStateWriteTransaction(
    () => db.prepare("DELETE FROM audit_events WHERE source_sequence BETWEEN 2 AND 11").run(),
    { database },
  );
  const input: AgentRunStartedAuditEventInput = {
    sourceId: "overflow-insert",
    sourceSequence: 100_010,
    occurredAt: occurredAt + 100_010,
    kind: "agent_run",
    action: "agent.run.started",
    status: "started",
    actorType: "agent",
    actorId: "main",
    agentId: "main",
    runId: "overflow-run",
  };
  expect(
    recordAuditEventInDatabase(
      { ...input, sourceId: "overflow-warm", sourceSequence: 100_009 },
      { database },
    )?.sequence,
  ).toBe(100_009);
  const finish: AgentRunFinishedAuditEventInput = {
    ...input,
    sourceId: "overflow-finish",
    sourceSequence: 100_011,
    action: "agent.run.finished",
    status: "succeeded",
  };
  const eventIds = ["overflow-start", "overflow-finish"] as const;
  const statements = observeAuditStatements(() => {
    recordAuditRunInDatabase(input, finish, { database }, eventIds);
  });
  // Two new rows cross the warmed 99,999-row bound: insert, delete, remaining expiry.
  expect(statements).toHaveLength(3);
  const retained = db
    .prepare(
      "SELECT COUNT(*) AS count, MIN(sequence) AS oldest, MAX(sequence) AS newest FROM audit_events",
    )
    .get();
  expect(Number(retained?.count)).toBe(retainedRows);
  expect(Number(retained?.oldest)).toBe(1_036);
  expect(Number(retained?.newest)).toBe(100_011);

  recordAuditRunInDatabase(input, finish, { database }, eventIds);
  expect(
    recordAuditEventInDatabase({ ...input, sourceId: "after-overflow" }, { database })?.sequence,
  ).toBe(100_014);
  expect(Number(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get()?.count)).toBe(
    retainedRows + 1,
  );
  expect(Number(db.prepare("SELECT MIN(sequence) AS oldest FROM audit_events").get()?.oldest)).toBe(
    1_036,
  );

  const expiry = observeAuditStatements(() => {
    recordAuditRunInDatabase(
      {
        ...input,
        sourceId: "expired-start",
        occurredAt: occurredAt - 30 * 24 * 60 * 60_000 - 1_000,
      },
      { ...finish, sourceId: "current-finish", occurredAt },
      { database },
      ["expired-start", "current-finish"],
    );
  });
  // Insert, bounded expiry delete, remaining expiry; no reread of the expired start.
  expect(expiry).toHaveLength(3);
  expect(
    db
      .prepare("SELECT event_id FROM audit_events WHERE event_id IN (?, ?)")
      .all("expired-start", "current-finish"),
  ).toEqual([{ event_id: "current-finish" }]);
}

export function assertAuditRetentionCountDrift(database: OpenClawStateDatabase): void {
  const { db } = database;
  const occurredAt = Date.now();
  seedAuditEvents(database, occurredAt, 99_999);
  const input: AuditEventInput = {
    sourceId: "count-drift",
    sourceSequence: 1,
    occurredAt,
    kind: "agent_run",
    action: "agent.run.started",
    status: "started",
    actorType: "agent",
    actorId: "main",
    agentId: "main",
    runId: "count-drift",
  };
  expect(recordAuditEventInDatabase(input, { database })?.sequence).toBe(100_000);
  // Change durable rows without the audit owner's retention invalidation.
  runOpenClawStateWriteTransaction(
    () => db.prepare("DELETE FROM audit_events WHERE sequence < 100000").run(),
    { database },
  );
  const recovery = observeAuditStatements(() => {
    expect(
      recordAuditEventInDatabase(
        { ...input, sourceId: "count-drift-2", sourceSequence: 2 },
        { database },
      )?.sequence,
    ).toBe(100_001);
  });
  // One insert, a zero-row overflow delete, and one count/expiry refresh.
  expect(recovery).toHaveLength(3);
  const steady = observeAuditStatements(() => {
    for (const sourceSequence of [3, 4]) {
      expect(
        recordAuditEventInDatabase(
          { ...input, sourceId: `count-drift-${sourceSequence}`, sourceSequence },
          { database },
        )?.sequence,
      ).toBe(99_999 + sourceSequence);
    }
  });
  expect(steady).toHaveLength(2);
  expect(steady.every((statement) => /^insert /i.test(statement))).toBe(true);
  expect(Number(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get()?.count)).toBe(4);
}

function auditRunInputs(runId: string) {
  const start: AgentRunStartedAuditEventInput = {
    sourceId: `${runId}-start`,
    sourceSequence: 1,
    occurredAt: Date.now(),
    kind: "agent_run",
    action: "agent.run.started",
    status: "started",
    actorType: "agent",
    actorId: "main",
    agentId: "main",
    runId,
  };
  const finish: AgentRunFinishedAuditEventInput = {
    ...start,
    sourceId: `${runId}-finish`,
    sourceSequence: 2,
    action: "agent.run.finished",
    status: "succeeded",
  };
  return { start, finish };
}

export function assertAuditRunWarmWrite(database: OpenClawStateDatabase): void {
  const options = { database };
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
  expect(
    database.db
      .prepare(
        "SELECT event_id, CAST(sequence AS TEXT) AS sequence FROM audit_events WHERE run_id = ? ORDER BY sequence",
      )
      .all("warm-pair"),
  ).toEqual([
    { event_id: "warm-start", sequence: "2" },
    { event_id: "warm-finish", sequence: "3" },
  ]);
}

export function assertAuditRunReplay(database: OpenClawStateDatabase): void {
  const options = { database };
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
    expect(
      database.db
        .prepare(
          "SELECT event_id, CAST(sequence AS TEXT) AS sequence FROM audit_events WHERE run_id = ? ORDER BY event_id",
        )
        .all(name),
    ).toEqual([
      { event_id: `${name}-finish`, sequence: String(sequences[1]) },
      { event_id: `${name}-start`, sequence: String(sequences[0]) },
    ]);
    const afterReplay = observeAuditStatements(() => {
      expect(
        recordAuditEventInDatabase(
          { ...start, sourceId: `${name}-after`, runId: `${name}-after` },
          options,
        )?.sequence,
      ).toBe(nextSequence);
    });
    if (!hasStart || !hasFinish) {
      expect(afterReplay).toEqual([expect.stringMatching(/^insert /i)]);
    }
  }
}

export function assertAuditRunAtomicity(database: OpenClawStateDatabase): void {
  const { db } = database;
  const options = { database };
  const invalid = auditRunInputs("invalid-run");
  const rejectPair = () =>
    recordAuditRunInDatabase(invalid.start, { ...invalid.finish, actorId: "" }, options, [
      "invalid-start",
      "invalid-finish",
    ]);
  expect(rejectPair).toThrow("invalid actorId");
  expect(Number(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get()?.count)).toBe(0);

  const retained = auditRunInputs("retained-run");
  recordAuditRunInDatabase(retained.start, retained.finish, options, ["kept-start", "kept-finish"]);
  // The same invalid finish must not leave a start once the SQLite owner is warm.
  expect(rejectPair).toThrow("invalid actorId");
  const rolledBack = auditRunInputs("rolled-back-run");
  expect(() =>
    runOpenClawStateWriteTransaction(() => {
      recordAuditRunInDatabase(rolledBack.start, rolledBack.finish, options, [
        "rolled-start",
        "rolled-finish",
      ]);
      throw new Error("rollback enclosing run pair");
    }, options),
  ).toThrow("rollback enclosing run pair");

  const next = recordAuditEventInDatabase(
    { ...retained.start, sourceId: "after-rollback", runId: "after-rollback" },
    options,
    "after-rollback",
  );
  expect(db.prepare("SELECT event_id FROM audit_events ORDER BY sequence").all()).toEqual([
    { event_id: "kept-start" },
    { event_id: "kept-finish" },
    { event_id: "after-rollback" },
  ]);
  // PG keeps sequence gaps after rollback; both engines must return the durable sequence.
  expect(
    Number(
      db
        .prepare("SELECT CAST(sequence AS TEXT) AS sequence FROM audit_events WHERE event_id = ?")
        .get("after-rollback")?.sequence,
    ),
  ).toBe(next?.sequence);
}
