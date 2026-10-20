// SQLite query-plan tests pin hot OpenClaw state indexes used by perf proof.
import type { StatementSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readConversationDeliveryInDatabase } from "../config/sessions/conversation-delivery-store.kernel.js";
import { deleteOrphanedTranscriptIndexRowsInTransaction } from "../config/sessions/session-transcript-index.js";
import { deriveDeliveryQueueRetentionColumns } from "../infra/delivery-queue-retention-columns.js";
import { countFailedDeliveryQueueEntriesInDatabase } from "../infra/delivery-queue-sqlite.kernel.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import {
  migrateSessionWatchCursorProvenance,
  needsSessionWatchCursorProvenanceMigration,
} from "./openclaw-state-db-session-watch-migration.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const planTempDirs = useAutoCleanupTempDirTracker(afterAll);

function createTempStateDir(): string {
  return planTempDirs.make("openclaw-sqlite-plan-");
}

function explainQueryPlan(
  db: EngineConnection,
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

function planAssertions(db: EngineConnection) {
  return (
    sql: string,
    params: readonly (number | string | null)[],
    includes: string[],
    excludes: string[] = [],
  ) => {
    const plan = explainQueryPlan(db, sql, params);
    for (const text of includes) {
      expect(plan).toContain(text);
    }
    for (const text of excludes) {
      expect(plan).not.toContain(text);
    }
  };
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("sqlite hot query plans", () => {
  it("bounds absent legacy watch detection and migration by the cursor index", () => {
    const { db } = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: createTempStateDir() },
    });
    const plans: string[] = [];
    const prototype = requireNodeSqlite().StatementSync.prototype;
    const observers = (["get", "all", "iterate"] as const).map((method) => {
      const original = prototype[method];
      return vi.spyOn(prototype, method).mockImplementation(
        new Proxy(original, {
          apply(target, receiver: StatementSync, params) {
            if (/^select .* from "session_watch_cursors" /i.test(receiver.sourceSQL)) {
              plans.push(explainQueryPlan(db, receiver.sourceSQL, params));
            }
            return Reflect.apply(target, receiver, params);
          },
        }),
      );
    });
    try {
      expect(needsSessionWatchCursorProvenanceMigration(requireNativeSqliteDatabase(db), 4)).toBe(
        false,
      );
      expect(migrateSessionWatchCursorProvenance(requireNativeSqliteDatabase(db))).toEqual({
        addedColumn: false,
        migratedAmbientWatches: 0,
        removedLegacySentinels: 0,
      });
    } finally {
      observers.forEach((observer) => observer.mockRestore());
    }
    expect(plans).toHaveLength(2);
    for (const plan of plans) {
      expect(plan).toMatch(
        /SEARCH session_watch_cursors .*\(watcher_session_key>\? AND watcher_session_key<\?\)/,
      );
      expect(plan).not.toContain("SCAN");
    }
  });

  it.each(["missing", "production", "stale"])(
    "checks orphan-query plans and preserves live rows with %s statistics",
    (statistics) => {
      const { db } = openOpenClawAgentDatabase({
        agentId: "worker-1",
        env: { OPENCLAW_STATE_DIR: createTempStateDir() },
      });
      // Multiple events per owner exercise the cost that a one-row fixture hides.
      db.exec(`PRAGMA foreign_keys = OFF;
        WITH RECURSIVE events(n) AS (VALUES(0) UNION ALL SELECT n + 1 FROM events WHERE n < 191)
        INSERT INTO transcript_events (session_id, seq, event_json, created_at)
          SELECT 'session-' || (n / 64), n % 64, '{}', 1 FROM events;
        INSERT INTO session_transcript_active_events
          (session_id, active_position, event_seq, context_eligible)
          SELECT session_id, seq, seq, 1 FROM transcript_events;
        PRAGMA foreign_keys = ON;`);
      if (statistics !== "missing") {
        db.exec(`ANALYZE;
          DELETE FROM sqlite_stat1;
          INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES
            ('transcript_events', 'sqlite_autoindex_transcript_events_1', '4763052 401 1'),
            ('session_transcript_active_events', 'sqlite_autoindex_session_transcript_active_events_1', '4747766 401 1'),
            ('session_transcript_active_events', 'idx_agent_transcript_active_event_seq', '4747766 401 1'),
            ('session_transcript_active_events', 'idx_agent_transcript_active_messages', '3774978 401 1'),
            ('session_transcript_active_events', 'idx_agent_transcript_context_pending', '0 0');`);
        if (statistics === "stale") {
          db.exec("UPDATE sqlite_stat1 SET stat = '1 1 1'");
        }
        db.exec("ANALYZE sqlite_schema");
      }

      const statements: string[] = [];
      const tracker = trackSqliteStatementExecutions(
        requireNativeSqliteDatabase(db),
        ["delete"],
        (sql) => {
          statements.push(sql);
          return "delete";
        },
      );
      try {
        db.exec("BEGIN IMMEDIATE");
        deleteOrphanedTranscriptIndexRowsInTransaction(db);
        db.exec("COMMIT");
        expect(tracker.counts).toEqual({ delete: 3 });
      } finally {
        tracker.restore();
      }
      const activeStatements = statements.filter((sql) =>
        sql.includes('from "session_transcript_active_events"'),
      );
      expect(activeStatements).toHaveLength(1);
      for (const sql of activeStatements) {
        const plan = explainQueryPlan(db, sql);
        expect(plan).not.toContain("CORRELATED");
        expect(plan).toContain("USING COVERING INDEX");
        if (statistics === "production") {
          expect(plan).toMatch(/SEARCH session_transcript_active_events .*\(session_id=\?\)/);
          const program = db.prepare(`EXPLAIN ${sql}`).all();
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
      db.exec(`PRAGMA foreign_keys = OFF;
        INSERT INTO session_transcript_active_events
          (session_id, active_position, event_seq, context_eligible) VALUES ('orphan', 0, 0, 1);
        PRAGMA foreign_keys = ON;`);
      db.exec("BEGIN IMMEDIATE");
      deleteOrphanedTranscriptIndexRowsInTransaction(db);
      db.exec("COMMIT");
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
    const sqlite = requireNativeSqliteDatabase(db);
    const unboundedColumns = deriveDeliveryQueueRetentionColumns("", "{}");
    sqlite
      .prepare(`INSERT INTO delivery_queue_entries
        (queue_name, id, status, entry_json, enqueued_at, updated_at, failed_at,
         retention_id_prefix, retention_max_age_ms, retention_max_entries)
      VALUES
        ('z', 'null', 'failed', '{}', 1, 1, NULL, @retention_id_prefix, @retention_max_age_ms, @retention_max_entries),
        ('a', 'late', 'failed', '{}', 1, 1, 30, @retention_id_prefix, @retention_max_age_ms, @retention_max_entries),
        ('a', 'b', 'failed', '{}', 1, 1, 10, @retention_id_prefix, @retention_max_age_ms, @retention_max_entries),
        ('a', 'a', 'failed', '{}', 1, 1, 10, @retention_id_prefix, @retention_max_age_ms, @retention_max_entries),
        ('a', 'null', 'failed', '{}', 1, 1, NULL, @retention_id_prefix, @retention_max_age_ms, @retention_max_entries),
        ('a', 'pending', 'pending', '{}', 1, 1, 0, @retention_id_prefix, @retention_max_age_ms, @retention_max_entries),
        ('pending-only', 'pending', 'pending', '{}', 1, 1, NULL, @retention_id_prefix, @retention_max_age_ms, @retention_max_entries);
    `)
      .run(unboundedColumns);
    sqlite
      .prepare(`WITH RECURSIVE history(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM history WHERE n < 200)
      INSERT INTO delivery_queue_entries
        (queue_name, id, status, entry_json, enqueued_at, updated_at, failed_at,
         retention_id_prefix, retention_max_age_ms, retention_max_entries)
      SELECT 'history-' || (n % 10), CAST(n AS TEXT), 'completed', '{}', 1, 1, 0,
        @retention_id_prefix, @retention_max_age_ms, @retention_max_entries
        FROM history;`)
      .run(unboundedColumns);

    for (const analyzed of [false, true]) {
      if (analyzed) {
        db.exec("ANALYZE");
      }
      let countSql = "";
      const reads = trackSqliteStatementExecutions(sqlite, ["countFailed"], (sql) => {
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
    const { db } = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: createTempStateDir() },
    });
    const check = planAssertions(db);
    check(
      `SELECT job_id, name, updated_at FROM cron_jobs WHERE store_key = ?
       ORDER BY sort_order ASC, updated_at ASC, job_id LIMIT 25`,
      ["/state/cron/jobs.json"],
      ["idx_cron_jobs_store_order"],
    );
    check(
      `SELECT id, entry_json FROM delivery_queue_entries WHERE queue_name = ? AND status = ?
       ORDER BY enqueued_at ASC, id LIMIT 50`,
      ["outbound", "pending"],
      ["idx_delivery_queue_pending"],
    );
    check(
      `SELECT entry_key, value_json FROM plugin_state_entries WHERE plugin_id = ? AND namespace = ?
       ORDER BY created_at ASC, entry_key LIMIT 50`,
      ["telegram", "kv"],
      ["idx_plugin_state_listing"],
      ["USE TEMP B-TREE FOR ORDER BY"],
    );
    for (const namespace of [undefined, "kv"]) {
      check(
        `SELECT count(*) FROM plugin_state_entries
         WHERE plugin_id = ? ${namespace ? "AND namespace = ?" : ""}
           AND (expires_at IS NULL OR expires_at > ?)`,
        namespace ? ["telegram", namespace, 1000] : ["telegram", 1000],
        ["USING COVERING INDEX idx_plugin_state_listing"],
      );
    }
    check(
      `SELECT event_id, payload_json FROM channel_ingress_events
       WHERE queue_name = ? AND status = ? ORDER BY received_at ASC, event_id LIMIT 50`,
      ["ingress", "pending"],
      ["idx_channel_ingress_pending"],
    );
  });

  it("keeps the reply-target delivery lookup on the partial reply index", () => {
    // A fresh store has no planner statistics, so the plan depends only on whether the partial index is usable.
    const database = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: createTempStateDir() },
    });
    const captured: Array<{ params: unknown[]; sql: string }> = [];
    const prototype = requireNodeSqlite().StatementSync.prototype;
    const observers = (["get", "all", "iterate"] as const).map((method) => {
      const original = prototype[method];
      return vi.spyOn(prototype, method).mockImplementation(
        new Proxy(original, {
          apply(target, receiver: StatementSync, params) {
            if (/from "conversation_deliveries" /i.test(receiver.sourceSQL)) {
              captured.push({ params, sql: receiver.sourceSQL });
            }
            return Reflect.apply(target, receiver, params);
          },
        }),
      );
    });
    try {
      expect(
        readConversationDeliveryInDatabase(database, {
          conversationRef: "conversation-1",
          replyToId: "message-1",
        }),
      ).toBeUndefined();
    } finally {
      observers.forEach((observer) => observer.mockRestore());
    }
    const [lookup] = captured;
    if (!lookup) {
      throw new Error("reply-target lookup statement was not captured");
    }
    const plan = explainQueryPlan(
      database.db,
      lookup.sql,
      lookup.params as (number | string | null)[],
    );
    expect(plan).toContain("idx_agent_conversation_deliveries_reply");
    expect(plan).not.toContain("SCAN delivery");
  });

  it("uses per-agent cache indexes for session metadata and expiry scans", () => {
    const { db } = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: createTempStateDir() },
    });
    const check = planAssertions(db);
    const noSort = ["USE TEMP B-TREE FOR ORDER BY"];
    check(
      "SELECT key, value_json FROM cache_entries WHERE scope = ? ORDER BY key ASC LIMIT 50",
      ["session_entries"],
      ["sqlite_autoindex_cache_entries_1"],
    );
    check(
      `SELECT session_key FROM session_nodes WHERE current_session_id = ?
       ORDER BY updated_at DESC, session_key ASC LIMIT 1`,
      ["session-1"],
      ["idx_agent_session_nodes_current_session_id"],
    );
    check(
      `SELECT session_id, updated_at FROM session_windows WHERE session_key = ?
       ORDER BY updated_at DESC, session_id ASC LIMIT 1`,
      ["agent:worker-1:main"],
      ["idx_agent_session_windows_session_key"],
      ["SCAN session_windows", ...noSort],
    );
    check(
      "DELETE FROM session_nodes WHERE session_key = ?",
      ["agent:worker-1:main"],
      ["idx_agent_session_windows_session_key"],
    );
    check(
      "SELECT session_key, entry_json FROM session_nodes WHERE status = ?",
      ["running"],
      ["idx_agent_session_nodes_status"],
    );
    check(
      "SELECT * FROM session_nodes WHERE archived_at IS NULL ORDER BY session_key",
      [],
      ["idx_agent_session_nodes_active"],
    );
    for (const activeOnly of [false, true]) {
      check(
        `SELECT entry_json FROM session_nodes WHERE entry_valid != ?${
          activeOnly ? " AND archived_at IS NULL" : ""
        }`,
        [1],
        ["idx_agent_session_nodes_entry_not_valid"],
      );
    }
    check(
      `SELECT te.event_json FROM transcript_events AS te
       JOIN transcript_event_identities AS ti ON ti.session_id = te.session_id AND ti.seq = te.seq
         WHERE te.session_id = ? AND ti.event_type = 'message'
         ORDER BY ti.seq DESC LIMIT 1`,
      ["session-1"],
      ["USING COVERING INDEX idx_agent_transcript_event_sequence (session_id=? AND event_type=?)"],
      noSort,
    );
    check(
      `SELECT identity.message_idempotency_key, event.event_json
         FROM transcript_event_identities AS identity
         JOIN transcript_events AS event ON event.session_id = identity.session_id AND event.seq = identity.seq
         WHERE identity.session_id = ?
           AND identity.message_idempotency_key IN (?, ?)
         ORDER BY identity.seq ASC`,
      ["session-1", "prompt-key", "assistant-key"],
      ["idx_agent_transcript_message_idempotency", "sqlite_autoindex_transcript_events_1"],
      ["SCAN transcript_events"],
    );
    check(
      "SELECT COUNT(seq) FROM transcript_event_identities WHERE session_id = ? AND event_type = ?",
      ["session-1", "message"],
      ["idx_agent_transcript_event_sequence"],
    );
    check(
      "DELETE FROM transcript_events WHERE session_id = ? AND seq = ?",
      ["session-1", 1],
      ["idx_agent_transcript_event_identity_sequence"],
    );
    check(
      "SELECT generation FROM transcript_rewrite_watermarks WHERE session_id = ?",
      ["session-1"],
      ["sqlite_autoindex_transcript_rewrite_watermarks_1"],
    );
    check(
      `SELECT seq, OCTET_LENGTH(event_json) + 1 AS serialized_bytes FROM transcript_events
       WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT 1001`,
      ["session-1", 90_000],
      ["sqlite_autoindex_transcript_events_1"],
      ["SCAN transcript_events", ...noSort],
    );
    check(
      "SELECT seq FROM transcript_events WHERE session_id = ? ORDER BY seq DESC LIMIT 1",
      ["session-1"],
      ["sqlite_autoindex_transcript_events_1"],
      ["SCAN transcript_events", ...noSort],
    );
    const historyIndexes = [
      "idx_agent_transcript_active_messages",
      "sqlite_autoindex_transcript_events_1",
    ];
    check(
      `SELECT active.event_seq, event.event_json FROM session_transcript_active_events AS active
         JOIN transcript_events AS event ON event.session_id = active.session_id AND event.seq = active.event_seq
         WHERE active.session_id = ?
           AND active.message_position IS NOT NULL AND active.message_position >= ? AND active.message_position < ?
         ORDER BY active.message_position ASC`,
      ["session-1", 100, 125],
      historyIndexes,
      noSort,
    );
    check(
      `SELECT active.event_seq, active.message_position, OCTET_LENGTH(event.event_json) + 1 AS serialized_bytes
         FROM session_transcript_active_events AS active
         JOIN transcript_events AS event ON event.session_id = active.session_id AND event.seq = active.event_seq
         WHERE active.session_id = ? AND active.message_position IS NOT NULL AND active.message_position >= ?
         ORDER BY active.message_position ASC LIMIT 1001`,
      ["session-1", 100],
      historyIndexes,
      noSort,
    );
    check(
      `SELECT active.event_seq, active.message_position, event.event_json, parent_identity.event_id AS parent_id
          FROM session_transcript_active_events AS active
          JOIN transcript_events AS event ON event.session_id = active.session_id AND event.seq = active.event_seq
          LEFT JOIN session_transcript_active_events AS parent_active
            ON parent_active.session_id = active.session_id
           AND parent_active.active_position = active.active_position - 1
          LEFT JOIN transcript_event_identities AS parent_identity
            ON parent_identity.session_id = parent_active.session_id AND parent_identity.seq = parent_active.event_seq
         WHERE active.session_id = ? AND active.message_position >= ? AND active.message_position < ?
         ORDER BY active.message_position ASC`,
      ["session-1", 100, 125],
      [
        ...historyIndexes,
        "sqlite_autoindex_session_transcript_active_events_1",
        "idx_agent_transcript_event_identity_sequence",
      ],
      noSort,
    );
    check(
      `SELECT active.message_position FROM transcript_event_identities AS identity
          JOIN session_transcript_active_events AS active
            ON active.session_id = identity.session_id AND active.event_seq = identity.seq
         WHERE identity.session_id = ? AND identity.event_id = ?`,
      ["session-1", "message-1"],
      ["sqlite_autoindex_transcript_event_identities_1", "idx_agent_transcript_active_event_seq"],
    );
  });
});
