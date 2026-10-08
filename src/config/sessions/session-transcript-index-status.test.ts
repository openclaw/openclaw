import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { enableNodeSqliteKyselyStatementCache } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import { admitSqliteSchema } from "../../infra/sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../state/openclaw-agent-schema.js";
import { drainTranscriptIndexStatus } from "./session-transcript-index-maintenance.js";
import {
  isSessionTranscriptIndexStatusClean,
  maintainSessionTranscriptIndexStatus,
} from "./session-transcript-index-status.worker.js";
import { sessionTranscriptIndexNeedsReconcile } from "./session-transcript-index.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0).toReversed()) {
    db.close();
  }
});

function createDatabase(filename = ":memory:") {
  const db = openNodeSqliteDatabase(filename);
  databases.push(db);
  db.exec(OPENCLAW_AGENT_SCHEMA_SQL);
  db.exec("PRAGMA foreign_keys = ON");
  enableNodeSqliteKyselyStatementCache(db);
  admitSqliteSchema(db);
  return db;
}

function seedCleanSession(db: DatabaseSync, sessionId: string) {
  const key = `agent:main:${sessionId}`;
  db.prepare(`INSERT INTO session_nodes
    (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, '{}', 1)`).run(
    key,
    sessionId,
  );
  db.prepare(`INSERT INTO session_windows
    (session_id, session_key, created_at, updated_at) VALUES (?, ?, 1, 1)`).run(sessionId, key);
  db.prepare(`INSERT INTO transcript_events
    (session_id, seq, event_json, created_at) VALUES (?, 0, '{}', 1)`).run(sessionId);
  db.prepare(`INSERT INTO session_transcript_active_events
    (session_id, active_position, event_seq, context_eligible) VALUES (?, 0, 0, 1)`).run(sessionId);
  db.prepare(`INSERT INTO session_transcript_index_state
    (session_id, indexed_seq, updated_at) VALUES (?, 0, 1)`).run(sessionId);
}

function maintain(db: DatabaseSync) {
  if (isSessionTranscriptIndexStatusClean(db)) {
    return { sessionIds: [], hasMore: false, traversalComplete: true };
  }
  return withoutTraversal(transaction(db, () => maintainSessionTranscriptIndexStatus(db)));
}

function withoutTraversal(result: ReturnType<typeof maintainSessionTranscriptIndexStatus>) {
  const { traversal: _traversal, ...status } = result;
  return status;
}

function transaction<T>(db: DatabaseSync, run: () => T): T {
  return withSqlitePostCommitPublications(db, () => runSqliteImmediateTransactionSync(db, run));
}

function settle(db: DatabaseSync) {
  for (let pass = 0; pass < 30; pass++) {
    const result = maintain(db);
    if (!result.hasMore) {
      return result;
    }
  }
  throw new Error("Bounded projection maintenance did not finish");
}

it("does not reconcile an empty transcript because of orphaned or another session's projection", () => {
  const db = createDatabase();
  seedCleanSession(db, "empty");
  seedCleanSession(db, "other");
  db.exec(`DELETE FROM transcript_events WHERE session_id = 'empty';
    UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = 'empty';
    UPDATE session_transcript_active_events SET context_eligible = NULL WHERE session_id = 'other';`);
  expect(sessionTranscriptIndexNeedsReconcile(db, "empty")).toBe(false);
  expect(sessionTranscriptIndexNeedsReconcile(db, "missing")).toBe(false);
  expect(sessionTranscriptIndexNeedsReconcile(db, "other")).toBe(true);
});

it("bounds admission, detects writes behind its cursor, and stops reading clean source tables", () => {
  const db = createDatabase();
  transaction(db, () => {
    for (let index = 0; index < 300; index++) {
      seedCleanSession(db, `z-${String(index).padStart(3, "0")}`);
    }
  });
  expect(maintain(db)).toEqual({ sessionIds: [], hasMore: true, traversalComplete: false });
  transaction(db, () => {
    seedCleanSession(db, "a-behind-cursor");
    db.prepare(
      "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
    ).run("a-behind-cursor");
  });
  expect(maintain(db).sessionIds).toEqual(["a-behind-cursor"]);
  db.exec("UPDATE session_transcript_index_state SET needs_rebuild = 0");
  expect(settle(db)).toEqual({ sessionIds: [], hasMore: false, traversalComplete: true });
  const observation = observeSqliteReadSql(StatementSync.prototype);
  try {
    for (let repeat = 0; repeat < 3; repeat++) {
      expect(maintain(db)).toEqual({ sessionIds: [], hasMore: false, traversalComplete: true });
    }
    expect(
      observation.queries.filter((query) =>
        /\b(?:from|join)\s+"?(?:session_windows|transcript_events|session_transcript_(?:active_events|fts_rows|index_state))\b/iu.test(
          query,
        ),
      ),
    ).toEqual([]);
  } finally {
    observation.restore();
  }
  db.exec(
    "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id LIKE 'z-%'",
  );
  expect(maintain(db)).toMatchObject({ hasMore: true, traversalComplete: false });
  const requeuePrefix = db.prepare(`UPDATE session_transcript_index_state SET needs_rebuild = 1
    WHERE session_id >= 'z-000' AND session_id < 'z-128'`);
  let reachedLateSession = false;
  for (let batch = 0; batch < 8; batch++) {
    requeuePrefix.run();
    const result = maintain(db);
    if (result.traversalComplete) {
      expect(result.sessionIds).toContain("z-299");
      reachedLateSession = true;
      break;
    }
  }
  expect(reachedLateSession).toBe(true);
  const pending = settle(db);
  expect(pending).toMatchObject({ hasMore: false, traversalComplete: true });
  expect(pending.sessionIds).toHaveLength(300);
});

it("rolls back admission and pending facts with raw writes, including nested savepoints", () => {
  const db = createDatabase();
  seedCleanSession(db, "seed");
  expect(() =>
    transaction(db, () => {
      maintainSessionTranscriptIndexStatus(db);
      throw new Error("cancel admission");
    }),
  ).toThrow("cancel admission");
  expect(settle(db)).toEqual({ sessionIds: [], hasMore: false, traversalComplete: true });
  transaction(db, () => {
    expect(() =>
      transaction(db, () => {
        db.exec(`INSERT INTO transcript_events
        (session_id, seq, event_json, created_at) VALUES ('seed', 1, '{}', 2)`);
        expect(maintainSessionTranscriptIndexStatus(db).sessionIds).toEqual(["seed"]);
        throw new Error("cancel append");
      }),
    ).toThrow("cancel append");
    const restored = maintainSessionTranscriptIndexStatus(db);
    expect(restored.traversal?.completedTraversals).toBe(1);
    expect(withoutTraversal(restored)).toEqual({
      sessionIds: [],
      hasMore: false,
      traversalComplete: true,
    });
  });
  db.exec(`INSERT INTO transcript_events
    (session_id, seq, event_json, created_at) VALUES ('seed', 1, '{}', 2)`);
  expect(maintain(db).sessionIds).toEqual(["seed"]);
  db.exec(`INSERT OR REPLACE INTO transcript_events
    (session_id, seq, event_json, created_at) VALUES ('seed', 1, '{}', 3)`);
  expect(maintain(db).sessionIds).toEqual(["seed"]);
  db.exec("UPDATE session_transcript_index_state SET indexed_seq = 1");
  expect(maintain(db)).toEqual({ sessionIds: [], hasMore: false, traversalComplete: true });
});

it("refreshes foreign append, classification, orphan, and schema mutations", () => {
  const filename = path.join(tempDirs.make("projection-status-"), "agent.sqlite");
  const db = createDatabase(filename);
  db.exec("PRAGMA journal_mode = WAL");
  seedCleanSession(db, "foreign");
  expect(settle(db)).toEqual({ sessionIds: [], hasMore: false, traversalComplete: true });
  const peer = new DatabaseSync(filename);
  databases.push(peer);
  peer.exec(`BEGIN;
    INSERT INTO transcript_events
      (session_id, seq, event_json, created_at) VALUES ('foreign', 1, '{}', 2);
    INSERT INTO session_transcript_fts_rows (session_id) VALUES ('orphan');
    COMMIT;`);
  expect(settle(db)).toEqual({ sessionIds: ["foreign"], hasMore: false, traversalComplete: true });
  expect(peer.prepare("SELECT count(*) AS count FROM session_transcript_fts_rows").get()).toEqual({
    count: 0,
  });
  peer.exec(`UPDATE session_transcript_index_state SET indexed_seq = 1;
    UPDATE session_transcript_active_events SET context_eligible = NULL;`);
  expect(settle(db).sessionIds).toEqual(["foreign"]);
  peer.exec("UPDATE session_transcript_active_events SET context_eligible = 1");
  expect(settle(db)).toEqual({ sessionIds: [], hasMore: false, traversalComplete: true });
  peer.exec("ALTER TABLE transcript_events ADD COLUMN external_note TEXT");
  expect(settle(db)).toEqual({ sessionIds: [], hasMore: false, traversalComplete: true });
  db.exec("UPDATE session_transcript_index_state SET needs_rebuild = 1");
  expect(maintain(db).sessionIds).toEqual(["foreign"]);
  peer.exec(`PRAGMA foreign_keys = ON;
    DELETE FROM session_nodes WHERE session_key = 'agent:main:foreign';`);
  expect(settle(db)).toEqual({ sessionIds: [], hasMore: false, traversalComplete: true });
});

it("limits orphan deletion per table while completing all sessions and FTS content", () => {
  const db = createDatabase();
  expect(settle(db)).toEqual({ sessionIds: [], hasMore: false, traversalComplete: true });
  // Simulate a foreign repair that left invalid derived rows with FK enforcement disabled.
  db.exec("PRAGMA foreign_keys = OFF");
  transaction(db, () => {
    const active = db.prepare(`INSERT INTO session_transcript_active_events
      (session_id, active_position, event_seq, context_eligible) VALUES (?, ?, ?, 1)`);
    const identity = db.prepare("INSERT INTO session_transcript_fts_rows (session_id) VALUES (?)");
    const content = db.prepare(`INSERT INTO session_transcript_fts (rowid, text, session_id)
      VALUES (last_insert_rowid(), 'orphan text', ?)`);
    for (const sessionId of ["orphan-a", "orphan-b", "orphan-c"]) {
      db.prepare(`INSERT INTO session_transcript_index_state
        (session_id, indexed_seq, updated_at) VALUES (?, 599, 1)`).run(sessionId);
      for (let index = 0; index < 600; index++) {
        active.run(sessionId, index, index);
        identity.run(sessionId);
        content.run(sessionId);
      }
    }
  });
  db.exec("PRAGMA foreign_keys = ON");
  expect(maintain(db)).toEqual({ sessionIds: [], hasMore: true, traversalComplete: false });
  for (const table of [
    "session_transcript_active_events",
    "session_transcript_fts_rows",
    "session_transcript_fts",
  ]) {
    expect(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 1288 });
  }
  expect(settle(db)).toEqual({ sessionIds: [], hasMore: false, traversalComplete: true });
  for (const table of [
    "session_transcript_active_events",
    "session_transcript_fts_rows",
    "session_transcript_fts",
    "session_transcript_index_state",
  ]) {
    expect(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
  }
});

it("cleans late orphans during continuous foreign commits and certifies readiness afterward", async () => {
  const filename = path.join(tempDirs.make("projection-status-busy-"), "agent.sqlite");
  const db = createDatabase(filename);
  db.exec("PRAGMA journal_mode = WAL");
  transaction(db, () => {
    for (let index = 0; index < 300; index++) {
      seedCleanSession(db, `session-${String(index).padStart(3, "0")}`);
    }
  });
  const peer = new DatabaseSync(filename);
  databases.push(peer);
  peer.exec("INSERT INTO session_transcript_fts_rows (session_id) VALUES ('zzzz-orphan')");
  let calls = 0;
  const result = await drainTranscriptIndexStatus(async () => {
    if (++calls > 32) {
      throw new Error("Status admission waited for a quiet database");
    }
    peer.exec(
      "UPDATE session_transcript_index_state SET needs_rebuild = 1, updated_at = updated_at + 1 WHERE session_id = 'session-000'",
    );
    return maintain(db);
  });
  expect(result).toEqual({ sessionIds: ["session-000"], hasMore: true, traversalComplete: true });
  expect(peer.prepare("SELECT session_id FROM session_transcript_fts_rows").all()).toEqual([]);
  expect(settle(db)).toEqual({
    sessionIds: ["session-000"],
    hasMore: false,
    traversalComplete: true,
  });
});
