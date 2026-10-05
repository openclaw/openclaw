// SQLite query-plan tests pin hot OpenClaw state indexes used by perf proof.
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  deleteOrphanedTranscriptIndexRowsInTransaction,
  hasOrphanedTranscriptIndexRows,
} from "../config/sessions/session-transcript-index.js";
import { countFailedDeliveryQueueEntriesInDatabase } from "../infra/delivery-queue-sqlite.kernel.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const planTempDirs: string[] = [];

function createTempStateDir(): string {
  return makeTempDir(planTempDirs, "openclaw-sqlite-plan-");
}

function explainQueryPlan(
  db: DatabaseSync,
  sql: string,
  params: readonly (number | string | null)[] = [],
): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
    detail?: unknown;
  }>;
  return rows
    .map((row) => (typeof row.detail === "string" ? row.detail : JSON.stringify(row.detail ?? "")))
    .join("\n");
}

function expectPlanUsesIndex(params: {
  db: DatabaseSync;
  indexName: string;
  params?: readonly (number | string | null)[];
  sql: string;
}): void {
  expect(explainQueryPlan(params.db, params.sql, params.params)).toContain(params.indexName);
}

function expectPlanIncludes(params: {
  db: DatabaseSync;
  expected: string;
  params?: readonly (number | string | null)[];
  sql: string;
}): void {
  expect(explainQueryPlan(params.db, params.sql, params.params)).toContain(params.expected);
}

afterAll(() => {
  cleanupTempDirs(planTempDirs);
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("sqlite hot query plans", () => {
  it.each(["missing", "production", "stale"])(
    "checks orphan-query plans and preserves live rows with %s statistics",
    (statistics) => {
      const { db } = openOpenClawAgentDatabase({
        agentId: "worker-1",
        env: { OPENCLAW_STATE_DIR: createTempStateDir() },
      });
      // Multiple events per owner exercise the cost that a one-row fixture hides.
      db.exec(`
        PRAGMA foreign_keys = OFF;
        WITH RECURSIVE events(n) AS (
          VALUES(0) UNION ALL SELECT n + 1 FROM events WHERE n < 191
        )
        INSERT INTO transcript_events (session_id, seq, event_json, created_at)
          SELECT 'session-' || (n / 64), n % 64, '{}', 1 FROM events;
        INSERT INTO session_transcript_active_events
          (session_id, active_position, event_seq, context_eligible)
          SELECT session_id, seq, seq, 1 FROM transcript_events;
        PRAGMA foreign_keys = ON;
      `);
      if (statistics !== "missing") {
        db.exec(`
          ANALYZE;
          DELETE FROM sqlite_stat1;
          INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES
            ('transcript_events', 'sqlite_autoindex_transcript_events_1', '4763052 401 1'),
            ('session_transcript_active_events', 'sqlite_autoindex_session_transcript_active_events_1', '4747766 401 1'),
            ('session_transcript_active_events', 'idx_agent_transcript_active_event_seq', '4747766 401 1'),
            ('session_transcript_active_events', 'idx_agent_transcript_active_messages', '3774978 401 1'),
            ('session_transcript_active_events', 'idx_agent_transcript_context_pending', '0 0');
        `);
        if (statistics === "stale") {
          db.exec("UPDATE sqlite_stat1 SET stat = '1 1 1'");
        }
        db.exec("ANALYZE sqlite_schema");
      }

      const statements: { sql: string; kind: "read" | "delete" }[] = [];
      const tracker = trackSqliteStatementExecutions(db, ["read", "delete"], (sql) => {
        const kind = sql.startsWith("delete") ? "delete" : "read";
        statements.push({ sql, kind });
        return kind;
      });
      try {
        expect(hasOrphanedTranscriptIndexRows(db)).toBe(false);
        db.exec("BEGIN IMMEDIATE");
        deleteOrphanedTranscriptIndexRowsInTransaction(db);
        db.exec("COMMIT");
        expect(tracker.counts).toEqual({ read: 3, delete: 3 });
      } finally {
        tracker.restore();
      }
      const activeStatements = statements.filter((statement) =>
        statement.sql.includes('from "session_transcript_active_events"'),
      );
      expect(activeStatements).toHaveLength(2);
      for (const { sql, kind } of activeStatements) {
        const params = kind === "read" ? [1] : [];
        const plan = explainQueryPlan(db, sql, params);
        expect(plan).not.toContain("CORRELATED");
        expect(plan).toContain("USING COVERING INDEX");
        if (kind === "delete" && statistics === "production") {
          expect(plan).toMatch(/SEARCH session_transcript_active_events .*\(session_id=\?\)/);
        }
        if (statistics === "production") {
          const program = db.prepare(`EXPLAIN ${sql}`).all(...params);
          for (const table of ["session_transcript_active_events", "transcript_events"]) {
            const roots = new Set(
              db
                .prepare("SELECT rootpage FROM sqlite_schema WHERE type = 'index' AND tbl_name = ?")
                .all(table)
                .map((row) => row.rootpage),
            );
            const cursors = new Set(
              program
                .filter((op) => op.opcode === "OpenRead" && roots.has(op.p2))
                .map((op) => op.p1),
            );
            // SCAN alone is ambiguous: SeekGT jumps over duplicate session keys.
            expect(program.some((op) => op.opcode === "SeekGT" && cursors.has(op.p1))).toBe(true);
          }
        }
      }
      db.exec(`
        PRAGMA foreign_keys = OFF;
        INSERT INTO session_transcript_active_events
          (session_id, active_position, event_seq, context_eligible)
          VALUES ('orphan', 0, 0, 1);
        PRAGMA foreign_keys = ON;
      `);
      expect(hasOrphanedTranscriptIndexRows(db)).toBe(true);
      db.exec("BEGIN IMMEDIATE");
      deleteOrphanedTranscriptIndexRowsInTransaction(db);
      db.exec("COMMIT");
      expect(hasOrphanedTranscriptIndexRows(db)).toBe(false);
      expect(
        db.prepare("SELECT count(*) AS n FROM session_transcript_active_events").get(),
      ).toEqual({
        n: 192,
      });
    },
  );

  it("searches failed delivery ranges with and without planner statistics", () => {
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: createTempStateDir() },
    });
    const { db } = database;
    db.exec(`
      INSERT INTO delivery_queue_entries
        (queue_name, id, status, entry_json, enqueued_at, updated_at, failed_at)
      VALUES
        ('z', 'null', 'failed', '{}', 1, 1, NULL),
        ('a', 'late', 'failed', '{}', 1, 1, 30),
        ('a', 'b', 'failed', '{}', 1, 1, 10),
        ('a', 'a', 'failed', '{}', 1, 1, 10),
        ('a', 'null', 'failed', '{}', 1, 1, NULL),
        ('a', 'pending', 'pending', '{}', 1, 1, 0),
        ('pending-only', 'pending', 'pending', '{}', 1, 1, NULL);
      WITH RECURSIVE history(n) AS (
        VALUES(1) UNION ALL SELECT n + 1 FROM history WHERE n < 200
      )
      INSERT INTO delivery_queue_entries
        (queue_name, id, status, entry_json, enqueued_at, updated_at, failed_at)
      SELECT 'history-' || (n % 10), CAST(n AS TEXT), 'completed', '{}', 1, 1, 0
        FROM history;
    `);

    for (const analyzed of [false, true]) {
      if (analyzed) {
        db.exec("ANALYZE");
      }
      let countSql = "";
      const reads = trackSqliteStatementExecutions(db, ["countFailed"], (sql) => {
        countSql = sql;
        return "countFailed";
      });
      try {
        expect(countFailedDeliveryQueueEntriesInDatabase(database)).toEqual([
          { queueName: "a", count: 4, oldestFailedAt: 10 },
          { queueName: "z", count: 1 },
        ]);
        expect(reads.counts.countFailed).toBe(1);
      } finally {
        reads.restore();
      }
      const countPlan = explainQueryPlan(db, countSql, ["failed"]);
      expect(countPlan).toContain(
        "SEARCH delivery_queue_entries USING COVERING INDEX idx_delivery_queue_failed (status=?)",
      );
      expect(countPlan).not.toContain("SCAN");
      expect(countPlan).not.toContain("USE TEMP B-TREE");

      const listingSql = `SELECT id, failed_at FROM delivery_queue_entries
        WHERE queue_name = ? AND status = ? ORDER BY failed_at ASC, id ASC`;
      const listingPlan = explainQueryPlan(db, listingSql, ["a", "failed"]);
      expect(listingPlan).toContain(
        "SEARCH delivery_queue_entries USING COVERING INDEX idx_delivery_queue_failed (status=? AND queue_name=?)",
      );
      expect(listingPlan).not.toContain("USE TEMP B-TREE");
      expect(db.prepare(listingSql).all("a", "failed")).toEqual([
        { id: "null", failed_at: null },
        { id: "a", failed_at: 10 },
        { id: "b", failed_at: 10 },
        { id: "late", failed_at: 30 },
      ]);
    }
  });

  it("uses shared state indexes for list and queue queries", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expectPlanUsesIndex({
      db: database.db,
      indexName: "idx_cron_jobs_store_order",
      params: ["/state/cron/jobs.json"],
      sql: `
        SELECT job_id, name, updated_at
          FROM cron_jobs
         WHERE store_key = ?
         ORDER BY sort_order ASC, updated_at ASC, job_id
         LIMIT 25
      `,
    });
    expectPlanUsesIndex({
      db: database.db,
      indexName: "idx_delivery_queue_pending",
      params: ["outbound", "pending"],
      sql: `
        SELECT id, entry_json
          FROM delivery_queue_entries
         WHERE queue_name = ? AND status = ?
         ORDER BY enqueued_at ASC, id
         LIMIT 50
      `,
    });
    const pluginListingPlan = explainQueryPlan(
      database.db,
      `
        SELECT entry_key, value_json
          FROM plugin_state_entries
         WHERE plugin_id = ? AND namespace = ?
         ORDER BY created_at ASC, entry_key
         LIMIT 50
      `,
      ["telegram", "kv"],
    );
    expect(pluginListingPlan).toContain("idx_plugin_state_listing");
    expect(pluginListingPlan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
    for (const namespace of [undefined, "kv"]) {
      expectPlanIncludes({
        db: database.db,
        expected: "USING COVERING INDEX idx_plugin_state_listing",
        params: namespace ? ["telegram", namespace, 1000] : ["telegram", 1000],
        sql: `
          SELECT count(*)
            FROM plugin_state_entries
           WHERE plugin_id = ? ${namespace ? "AND namespace = ?" : ""}
             AND (expires_at IS NULL OR expires_at > ?)
        `,
      });
    }
    expectPlanUsesIndex({
      db: database.db,
      indexName: "idx_channel_ingress_pending",
      params: ["ingress", "pending"],
      sql: `
        SELECT event_id, payload_json
          FROM channel_ingress_events
         WHERE queue_name = ? AND status = ?
         ORDER BY received_at ASC, event_id
         LIMIT 50
      `,
    });
  });

  it("uses per-agent cache indexes for session metadata and expiry scans", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expectPlanIncludes({
      db: database.db,
      expected: "sqlite_autoindex_cache_entries_1",
      params: ["session_entries"],
      sql: `
        SELECT key, value_json
          FROM cache_entries
         WHERE scope = ?
         ORDER BY key ASC
         LIMIT 50
      `,
    });
    expectPlanUsesIndex({
      db: database.db,
      indexName: "idx_agent_session_nodes_current_session_id",
      params: ["session-1"],
      sql: `
        SELECT session_key
          FROM session_nodes
         WHERE current_session_id = ?
         ORDER BY updated_at DESC, session_key ASC
        LIMIT 1
      `,
    });
    const latestWindowPlan = explainQueryPlan(
      database.db,
      `
        SELECT session_id, updated_at
          FROM session_windows
         WHERE session_key = ?
         ORDER BY updated_at DESC, session_id ASC
         LIMIT 1
      `,
      ["agent:worker-1:main"],
    );
    expect(latestWindowPlan).toContain("idx_agent_session_windows_session_key");
    expect(latestWindowPlan).not.toContain("SCAN session_windows");
    expect(latestWindowPlan).not.toContain("USE TEMP B-TREE FOR ORDER BY");

    expectPlanUsesIndex({
      db: database.db,
      indexName: "idx_agent_session_windows_session_key",
      params: ["agent:worker-1:main"],
      sql: "DELETE FROM session_nodes WHERE session_key = ?",
    });
    expectPlanUsesIndex({
      db: database.db,
      indexName: "idx_agent_session_nodes_status",
      params: ["running"],
      sql: `
        SELECT session_key, entry_json
          FROM session_nodes
         WHERE status = ?
      `,
    });
    expectPlanUsesIndex({
      db: database.db,
      indexName: "idx_agent_session_nodes_active",
      sql: `
        SELECT *
          FROM session_nodes
         WHERE archived_at IS NULL
         ORDER BY session_key
      `,
    });
    for (const activeOnly of [false, true]) {
      expectPlanUsesIndex({
        db: database.db,
        indexName: "idx_agent_session_nodes_entry_not_valid",
        params: [1],
        sql: `SELECT entry_json FROM session_nodes WHERE entry_valid != ?${
          activeOnly ? " AND archived_at IS NULL" : ""
        }`,
      });
    }
    const latestMessagePlan = explainQueryPlan(
      database.db,
      `
        SELECT te.event_json
          FROM transcript_events AS te
          JOIN transcript_event_identities AS ti
            ON ti.session_id = te.session_id AND ti.seq = te.seq
         WHERE te.session_id = ? AND ti.event_type = 'message'
         ORDER BY ti.seq DESC
         LIMIT 1
      `,
      ["session-1"],
    );
    expect(latestMessagePlan).toContain(
      "USING COVERING INDEX idx_agent_transcript_event_sequence (session_id=? AND event_type=?)",
    );
    expect(latestMessagePlan).not.toContain("USE TEMP B-TREE FOR ORDER BY");

    const mirrorIdentityPlan = explainQueryPlan(
      database.db,
      `
        SELECT identity.message_idempotency_key, event.event_json
          FROM transcript_event_identities AS identity
          JOIN transcript_events AS event
            ON event.session_id = identity.session_id AND event.seq = identity.seq
         WHERE identity.session_id = ?
           AND identity.message_idempotency_key IN (?, ?)
         ORDER BY identity.seq ASC
      `,
      ["session-1", "prompt-key", "assistant-key"],
    );
    expect(mirrorIdentityPlan).toContain("idx_agent_transcript_message_idempotency");
    expect(mirrorIdentityPlan).toContain("sqlite_autoindex_transcript_events_1");
    expect(mirrorIdentityPlan).not.toContain("SCAN transcript_events");

    expectPlanUsesIndex({
      db: database.db,
      indexName: "idx_agent_transcript_event_sequence",
      params: ["session-1", "message"],
      sql: `
        SELECT COUNT(seq)
          FROM transcript_event_identities
         WHERE session_id = ? AND event_type = ?
      `,
    });
    expectPlanUsesIndex({
      db: database.db,
      indexName: "idx_agent_transcript_event_identity_sequence",
      params: ["session-1", 1],
      sql: "DELETE FROM transcript_events WHERE session_id = ? AND seq = ?",
    });

    expectPlanIncludes({
      db: database.db,
      expected: "sqlite_autoindex_transcript_rewrite_watermarks_1",
      params: ["session-1"],
      sql: `
        SELECT generation
          FROM transcript_rewrite_watermarks
         WHERE session_id = ?
      `,
    });
    const rawDeltaPlan = explainQueryPlan(
      database.db,
      `
        SELECT seq, OCTET_LENGTH(event_json) + 1 AS serialized_bytes
          FROM transcript_events
         WHERE session_id = ? AND seq > ?
         ORDER BY seq ASC
         LIMIT 1001
      `,
      ["session-1", 90_000],
    );
    expect(rawDeltaPlan).toContain("sqlite_autoindex_transcript_events_1");
    expect(rawDeltaPlan).not.toContain("SCAN transcript_events");
    expect(rawDeltaPlan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
    const rawFrontierPlan = explainQueryPlan(
      database.db,
      `
        SELECT seq
          FROM transcript_events
         WHERE session_id = ?
         ORDER BY seq DESC
         LIMIT 1
      `,
      ["session-1"],
    );
    expect(rawFrontierPlan).toContain("sqlite_autoindex_transcript_events_1");
    expect(rawFrontierPlan).not.toContain("SCAN transcript_events");
    expect(rawFrontierPlan).not.toContain("USE TEMP B-TREE FOR ORDER BY");

    const historyPagePlan = explainQueryPlan(
      database.db,
      `
        SELECT active.event_seq, event.event_json
          FROM session_transcript_active_events AS active
          JOIN transcript_events AS event
            ON event.session_id = active.session_id AND event.seq = active.event_seq
         WHERE active.session_id = ?
           AND active.message_position IS NOT NULL
           AND active.message_position >= ?
           AND active.message_position < ?
         ORDER BY active.message_position ASC
      `,
      ["session-1", 100, 125],
    );
    expect(historyPagePlan).toContain("idx_agent_transcript_active_messages");
    expect(historyPagePlan).toContain("sqlite_autoindex_transcript_events_1");
    expect(historyPagePlan).not.toContain("USE TEMP B-TREE FOR ORDER BY");

    const visibleDeltaPlan = explainQueryPlan(
      database.db,
      `
        SELECT active.event_seq, active.message_position,
               OCTET_LENGTH(event.event_json) + 1 AS serialized_bytes
          FROM session_transcript_active_events AS active
          JOIN transcript_events AS event
            ON event.session_id = active.session_id AND event.seq = active.event_seq
         WHERE active.session_id = ?
           AND active.message_position IS NOT NULL
           AND active.message_position >= ?
         ORDER BY active.message_position ASC
         LIMIT 1001
      `,
      ["session-1", 100],
    );
    expect(visibleDeltaPlan).toContain("idx_agent_transcript_active_messages");
    expect(visibleDeltaPlan).toContain("sqlite_autoindex_transcript_events_1");
    expect(visibleDeltaPlan).not.toContain("USE TEMP B-TREE FOR ORDER BY");

    const visibleDeltaPayloadPlan = explainQueryPlan(
      database.db,
      `
        SELECT active.event_seq, active.message_position, event.event_json,
               parent_identity.event_id AS parent_id
          FROM session_transcript_active_events AS active
          JOIN transcript_events AS event
            ON event.session_id = active.session_id AND event.seq = active.event_seq
          LEFT JOIN session_transcript_active_events AS parent_active
            ON parent_active.session_id = active.session_id
           AND parent_active.active_position = active.active_position - 1
          LEFT JOIN transcript_event_identities AS parent_identity
            ON parent_identity.session_id = parent_active.session_id
           AND parent_identity.seq = parent_active.event_seq
         WHERE active.session_id = ?
           AND active.message_position >= ?
           AND active.message_position < ?
         ORDER BY active.message_position ASC
      `,
      ["session-1", 100, 125],
    );
    expect(visibleDeltaPayloadPlan).toContain("idx_agent_transcript_active_messages");
    expect(visibleDeltaPayloadPlan).toContain("sqlite_autoindex_transcript_events_1");
    expect(visibleDeltaPayloadPlan).toContain(
      "sqlite_autoindex_session_transcript_active_events_1",
    );
    expect(visibleDeltaPayloadPlan).toContain("idx_agent_transcript_event_identity_sequence");
    expect(visibleDeltaPayloadPlan).not.toContain("USE TEMP B-TREE FOR ORDER BY");

    const historyAnchorPlan = explainQueryPlan(
      database.db,
      `
        SELECT active.message_position
          FROM transcript_event_identities AS identity
          JOIN session_transcript_active_events AS active
            ON active.session_id = identity.session_id AND active.event_seq = identity.seq
         WHERE identity.session_id = ? AND identity.event_id = ?
      `,
      ["session-1", "message-1"],
    );
    expect(historyAnchorPlan).toContain("sqlite_autoindex_transcript_event_identities_1");
    expect(historyAnchorPlan).toContain("idx_agent_transcript_active_event_seq");
  });
});
