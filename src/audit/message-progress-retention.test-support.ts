import { channel } from "node:diagnostics_channel";
import { expect } from "vitest";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  pruneExpiredOutboundMessageProgressInDatabase,
  recordOutboundMessageProgressInDatabase,
} from "./message-delivery-progress-store.js";

export function assertMessageProgressOverflowRetention(database: OpenClawStateDatabase): void {
  const options = { database };
  const now = Date.now();
  const append = (sourceId: string) =>
    recordOutboundMessageProgressInDatabase(
      {
        sourceId,
        sourceSequence: 1,
        occurredAt: now,
        kind: "message",
        action: "message.outbound.queued",
        status: "started",
        outcome: "queued",
        actorType: "agent",
        actorId: "synthetic-agent",
        runId: "synthetic-run",
        direction: "outbound",
        channel: "qa-channel",
        conversationKind: "direct",
        resultCount: 0,
      },
      options,
    );
  append("bootstrap");
  const { db } = database;
  runOpenClawStateWriteTransaction(() => {
    db.prepare(
      `WITH digits(d) AS (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
            numbers(n) AS (
              SELECT 1 + a.d + 10*b.d + 100*c.d + 1000*d.d + 10000*e.d + 100000*f.d
              FROM digits a, digits b, digits c, digits d, digits e, digits f
            )
       INSERT INTO outbound_message_progress (
         progress_id, source_id, source_sequence, schema_version, occurred_at,
         action, outcome, actor_type, actor_id, run_id, channel, conversation_kind
       ) SELECT 'progress-' || n, 'source-' || n, n, 1, CAST(? AS BIGINT),
                'message.outbound.queued', 'queued', 'agent', 'synthetic-agent',
                'synthetic-run', 'qa-channel', 'direct'
         FROM numbers WHERE n <= 200008 ORDER BY n`,
    ).run(now);
    db.prepare("DELETE FROM outbound_message_progress WHERE sequence BETWEEN 2 AND 11").run();
  }, options);
  pruneExpiredOutboundMessageProgressInDatabase({ database: options, now });
  expect(append("at-cap")?.sequence).toBe(200_010);

  const retained = () => {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS count, MIN(sequence) AS oldest, MAX(sequence) AS newest FROM outbound_message_progress",
      )
      .get();
    return [Number(row?.count), Number(row?.oldest), Number(row?.newest)];
  };
  const statements: string[] = [];
  const observation = channel("openclaw.database.statement");
  const observe = (event: unknown) => {
    if (
      event &&
      typeof event === "object" &&
      "sql" in event &&
      typeof event.sql === "string" &&
      event.sql.includes("outbound_message_progress")
    ) {
      statements.push(event.sql);
    }
  };
  observation.subscribe(observe);
  try {
    expect(append("overflow")?.sequence).toBe(200_011);
    // Insert, bounded expiry delete, overflow delete, and returned-row read.
    const overflowStatements = statements.length;
    expect(retained()).toEqual([198_976, 1_036, 200_011]);
    statements.length = 0;

    expect(append("after-overflow")?.sequence).toBe(200_012);
    const appendStatements = statements.length;
    expect(retained()).toEqual([198_977, 1_036, 200_012]);
    expect([overflowStatements, appendStatements]).toEqual([4, 3]);
  } finally {
    observation.unsubscribe(observe);
  }
}
