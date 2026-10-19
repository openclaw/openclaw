import { channel } from "node:diagnostics_channel";
import { expect } from "vitest";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { recordAuditEventInDatabase } from "./audit-event-store.js";
import type { AuditEventInput } from "./audit-event-types.js";

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

function observeAuditStatements(action: () => void): string[] {
  const statements: string[] = [];
  const observation = channel("openclaw.database.statement");
  const observe = (event: unknown) => {
    if (event && typeof event === "object" && "sql" in event && typeof event.sql === "string") {
      if (event.sql.includes("audit_events")) {
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
  seedAuditEvents(database, occurredAt, 100_011);
  // Gaps must not move the retained row boundary or reset sequence allocation.
  runOpenClawStateWriteTransaction(
    () => db.prepare("DELETE FROM audit_events WHERE source_sequence BETWEEN 2 AND 11").run(),
    { database },
  );
  const input: AuditEventInput = {
    sourceId: "overflow-insert",
    sourceSequence: 100_012,
    occurredAt: occurredAt + 100_012,
    kind: "agent_run",
    action: "agent.run.started",
    status: "started",
    actorType: "agent",
    actorId: "main",
    agentId: "main",
    runId: "overflow-run",
  };
  const statements = observeAuditStatements(() => {
    expect(recordAuditEventInDatabase(input, { database })?.sequence).toBe(100_012);
  });
  // Insert, cold retention facts, bounded deletion, and the remaining expiry boundary.
  expect(statements).toHaveLength(4);
  const retained = db
    .prepare(
      "SELECT COUNT(*) AS count, MIN(sequence) AS oldest, MAX(sequence) AS newest FROM audit_events",
    )
    .get();
  expect(Number(retained?.count)).toBe(retainedRows);
  expect(Number(retained?.oldest)).toBe(1_037);
  expect(Number(retained?.newest)).toBe(100_012);

  expect(recordAuditEventInDatabase(input, { database })).toBeUndefined();
  expect(
    recordAuditEventInDatabase({ ...input, sourceId: "after-overflow" }, { database })?.sequence,
  ).toBe(100_014);
  expect(Number(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get()?.count)).toBe(
    retainedRows + 1,
  );
  expect(Number(db.prepare("SELECT MIN(sequence) AS oldest FROM audit_events").get()?.oldest)).toBe(
    1_037,
  );
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
