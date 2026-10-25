import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  observeSqliteReadSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { enableNodeSqliteKyselyStatementCache } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import type * as SqliteDatabaseAdmission from "../../infra/sqlite-database-admission.js";
import type { AdmissionOperations } from "../../infra/sqlite-database-admission.worker.test-support.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import {
  admitSqliteSchema,
  registerSqliteSchemaMutationListener,
} from "../../infra/sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { SqliteWorkerBroker } from "../../infra/sqlite-worker-broker.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../state/openclaw-agent-schema.js";
import { drainTranscriptIndexStatus } from "./session-transcript-index-maintenance.js";
import { maintainSessionTranscriptIndexStatus } from "./session-transcript-index-status.worker.js";
import { sessionTranscriptIndexNeedsReconcile } from "./session-transcript-index.js";
import {
  bindSqliteWorkerBackend,
  type TranscriptProjectionPublicationOperations,
} from "./session-transcript-projection-publication.worker.js";

const siblingRevision = vi.hoisted(() => ({ unknown: false }));
vi.mock("../../infra/sqlite-database-admission.js", async (importOriginal) => {
  const actual = await importOriginal<typeof SqliteDatabaseAdmission>();
  return {
    ...actual,
    readSqliteDatabaseSiblingWriteRevision: (db: DatabaseSync) =>
      siblingRevision.unknown ? undefined : actual.readSqliteDatabaseSiblingWriteRevision(db),
  };
});

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

function pairedDatabases(label: string) {
  const filename = path.join(tempDirs.make(label), "agent.sqlite");
  const db = createDatabase(filename);
  const other = openNodeSqliteDatabase(filename);
  databases.push(other);
  return { filename, db, other };
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

function expectStatus(
  actual: ReturnType<typeof withoutTraversal>,
  sessionIds: string[] = [],
  hasMore = false,
  traversalComplete = !hasMore,
) {
  expect(actual).toEqual({ sessionIds, hasMore, traversalComplete });
}

function maintain(db: DatabaseSync) {
  return withoutTraversal(transaction(db, () => maintainSessionTranscriptIndexStatus(db)));
}

function withoutTraversal(result: ReturnType<typeof maintainSessionTranscriptIndexStatus>) {
  const { traversal: _traversal, ...status } = result;
  return status;
}

function transaction<T>(db: DatabaseSync, run: () => T): T {
  return withSqlitePostCommitPublications(db, () => runSqliteImmediateTransactionSync(db, run));
}

function seedSessions(db: DatabaseSync, prefix: string, count = 300) {
  transaction(db, () => {
    for (let index = 0; index < count; index++) {
      seedCleanSession(db, prefix + String(index).padStart(3, "0"));
    }
  });
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

it("uses the queue it just rebuilt on admission and still observes subsequent writes", () => {
  const db = createDatabase();
  seedCleanSession(db, "dirty-z");
  seedCleanSession(db, "dirty-a");
  db.exec("UPDATE session_transcript_index_state SET needs_rebuild = 1");
  const reads = trackSqliteStatementExecutions(db, ["queue"], (sql) =>
    /^select "session_id" from "temp"\."openclaw_transcript_index_pending"/iu.test(sql)
      ? "queue"
      : null,
  );
  try {
    expectStatus(maintain(db), ["dirty-a", "dirty-z"]);
    expect(reads.counts.queue).toBe(0);
  } finally {
    reads.restore();
  }
  db.exec("UPDATE session_transcript_index_state SET needs_rebuild = 0");
  expectStatus(maintain(db));
});

it.each(["preflight", "sweep"] as const)(
  "%s leaves the writer lock free during both host grants and reads subsequent writes",
  (type) => {
    const { filename, db, other } = pairedDatabases("index-admission-");
    other.exec("PRAGMA busy_timeout = 0");
    const writable: boolean[] = [];
    const backend = bindSqliteWorkerBackend(undefined, {
      database: db,
      databasePath: filename,
      admit(stage) {
        try {
          other.exec("BEGIN IMMEDIATE");
          writable.push(true);
          if (stage === "commit") {
            seedCleanSession(other, "arrived-during-admission");
            other.exec("UPDATE session_transcript_index_state SET needs_rebuild = 1");
          }
          other.exec("COMMIT");
        } catch {
          writable.push(false);
          if (other.isTransaction) {
            other.exec("ROLLBACK");
          }
        }
      },
    });
    const result = backend.execute({ type, input: undefined });
    expect(writable).toEqual([true, true]);
    expect(result).toMatchObject({ sessionIds: ["arrived-during-admission"] });
    backend.assertSettled();
  },
);

it("yields contended maintenance without a transaction and reacquires admission on retry", () => {
  const { filename, db, other } = pairedDatabases("index-contention-");
  const admit = vi.fn();
  const backend = bindSqliteWorkerBackend(undefined, {
    database: db,
    databasePath: filename,
    admit,
  });
  other.exec("BEGIN IMMEDIATE");
  try {
    expect(backend.execute({ type: "preflight", input: undefined })).toEqual({
      sessionIds: [],
      hasMore: true,
      traversalComplete: false,
    });
    backend.assertSettled();
  } finally {
    other.exec("ROLLBACK");
  }
  expect(admit.mock.calls).toEqual([["transaction"], ["commit"]]);
  expect(backend.execute({ type: "preflight", input: undefined })).toMatchObject({
    sessionIds: [],
    hasMore: false,
    traversalComplete: true,
  });
  expect(admit.mock.calls).toEqual([["transaction"], ["commit"], ["transaction"], ["commit"]]);
});

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
  seedSessions(db, "z-");
  const mainSchemaMutation = vi.fn();
  registerSqliteSchemaMutationListener(db, mainSchemaMutation);
  expectStatus(maintain(db), [], true);
  expect(mainSchemaMutation).not.toHaveBeenCalled();
  transaction(db, () => {
    seedCleanSession(db, "a-behind-cursor");
    db.prepare(
      "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
    ).run("a-behind-cursor");
  });
  expect(maintain(db).sessionIds).toEqual(["a-behind-cursor"]);
  db.exec("UPDATE session_transcript_index_state SET needs_rebuild = 0");
  expectStatus(settle(db));
  const observation = observeSqliteReadSql(StatementSync.prototype);
  try {
    for (let repeat = 0; repeat < 3; repeat++) {
      expectStatus(maintain(db));
    }
    expect(observation.queries.filter((query) => /\bdata_version\b/iu.test(query))).toEqual([]);
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

it("classifies a pending batch with bounded SQL and preserves later projection changes", () => {
  const db = createDatabase();
  settle(db);
  const sessionIds = Array.from(
    { length: 96 },
    (_, index) => `session-${String(index).padStart(3, "0")}`,
  );
  transaction(db, () => {
    for (const sessionId of sessionIds) {
      seedCleanSession(db, sessionId);
    }
    db.exec("UPDATE session_transcript_index_state SET needs_rebuild = 1");
  });
  const statements = trackSqliteStatementExecutions(db, ["all"], () => "all");
  try {
    expectStatus(maintain(db), sessionIds);
    // Classification and queue consumption are bounded commands, not commands per session.
    expect(statements.counts.all).toBeLessThanOrEqual(16);
  } finally {
    statements.restore();
  }
  transaction(db, () => {
    db.exec(`UPDATE session_transcript_index_state SET needs_rebuild = 0
      WHERE session_id <> 'session-095';
      INSERT INTO transcript_events (session_id, seq, event_json, created_at)
        VALUES ('session-000', 1, '{}', 2);
      UPDATE session_transcript_active_events SET context_eligible = NULL
        WHERE session_id = 'session-001';`);
  });
  expectStatus(maintain(db), ["session-000", "session-001", "session-095"]);
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
  expectStatus(settle(db));
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
    expectStatus(withoutTraversal(restored));
  });
  db.exec(`INSERT INTO transcript_events
    (session_id, seq, event_json, created_at) VALUES ('seed', 1, '{}', 2)`);
  expect(maintain(db).sessionIds).toEqual(["seed"]);
  db.exec(`INSERT OR REPLACE INTO transcript_events
    (session_id, seq, event_json, created_at) VALUES ('seed', 1, '{}', 3)`);
  expect(maintain(db).sessionIds).toEqual(["seed"]);
  db.exec("UPDATE session_transcript_index_state SET indexed_seq = 1");
  expectStatus(maintain(db));
});

it("refreshes worker append, classification, orphan, and deletion receipts without freshness probes", async () => {
  const filename = path.join(tempDirs.make("projection-status-"), "agent.sqlite");
  const db = createDatabase(filename);
  db.exec("PRAGMA journal_mode = WAL");
  seedCleanSession(db, "worker");
  expectStatus(settle(db));
  const broker = new SqliteWorkerBroker();
  const probes = trackSqliteStatementExecutions(db, ["fresh"], (sql) =>
    /\bdata_version\b/iu.test(sql) ? "fresh" : null,
  );
  try {
    const store = await broker.open<AdmissionOperations>({
      moduleUrl: new URL(
        "../../infra/sqlite-database-admission.worker.test-support.ts",
        import.meta.url,
      ),
      databasePath: filename,
      input: undefined,
    });
    const write = (sql: string) =>
      broker.runOperation(store!, (scope) => scope.execute({ type: "writeRows", input: { sql } }));
    await write(`BEGIN;
      INSERT INTO transcript_events
        (session_id, seq, event_json, created_at) VALUES ('worker', 1, '{}', 2);
      INSERT INTO session_transcript_fts_rows (session_id) VALUES ('orphan');
      COMMIT;`);
    expectStatus(settle(db), ["worker"]);
    expect(db.prepare("SELECT count(*) AS count FROM session_transcript_fts_rows").get()).toEqual({
      count: 0,
    });
    await write(`UPDATE session_transcript_index_state SET indexed_seq = 1;
      UPDATE session_transcript_active_events SET context_eligible = NULL;`);
    expect(settle(db).sessionIds).toEqual(["worker"]);
    await write("UPDATE session_transcript_active_events SET context_eligible = 1");
    expectStatus(settle(db));
    db.exec("ALTER TABLE transcript_events ADD COLUMN repaired_note TEXT");
    admitSqliteSchema(db);
    expectStatus(settle(db));
    db.exec("UPDATE session_transcript_index_state SET needs_rebuild = 1");
    expect(maintain(db).sessionIds).toEqual(["worker"]);
    await write(`PRAGMA foreign_keys = ON;
      DELETE FROM session_nodes WHERE session_key = 'agent:main:worker';`);
    expectStatus(settle(db));
    expect(probes.counts.fresh).toBe(0);
  } finally {
    probes.restore();
    await broker.close();
  }
});

it("bounds empty-window projection probes by maintenance page, not session count", () => {
  const db = createDatabase();
  seedSessions(db, "empty-", 1000);
  db.exec(`DELETE FROM transcript_events;
    DELETE FROM session_transcript_active_events;
    DELETE FROM session_transcript_index_state;`);
  const reads = trackSqliteStatementExecutions(db, ["projection"], (sql) =>
    /^select .*"rowid" as "rowId" from "session_transcript_/iu.test(sql) ? "projection" : null,
  );
  try {
    expectStatus(settle(db));
    expect(reads.counts.projection).toBe(3 * Math.ceil(1000 / 128));
  } finally {
    reads.restore();
  }
});

it("limits orphan deletion per table while completing all sessions and FTS content", () => {
  const db = createDatabase();
  expectStatus(settle(db));
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
  expectStatus(maintain(db), [], true);
  const tables = [
    "session_transcript_active_events",
    "session_transcript_fts_rows",
    "session_transcript_fts",
    "session_transcript_index_state",
  ];
  const counts = (names: string[]) =>
    names.map((table) => db.prepare(`SELECT count(*) AS count FROM ${table}`).get());
  expect(counts(tables.slice(0, 3))).toEqual(Array.from({ length: 3 }, () => ({ count: 1288 })));
  expectStatus(settle(db));
  expect(counts(tables)).toEqual(Array.from({ length: 4 }, () => ({ count: 0 })));
});

it("cleans late orphans during continuous sibling commits and certifies readiness afterward", async () => {
  const filename = path.join(tempDirs.make("projection-status-busy-"), "agent.sqlite");
  const db = createDatabase(filename);
  db.exec("PRAGMA journal_mode = WAL");
  seedSessions(db, "session-");
  const peer = openNodeSqliteDatabase(filename);
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
  expectStatus(result, ["session-000"], true, true);
  expect(peer.prepare("SELECT session_id FROM session_transcript_fts_rows").all()).toEqual([]);
  expectStatus(settle(db), ["session-000"]);
});

it("reaches a late dirty session while the sibling write revision stays unknown", async () => {
  const db = createDatabase();
  seedSessions(db, "z-");
  db.exec("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = 'z-299'");
  siblingRevision.unknown = true;
  try {
    // Mirrors the reconcile backlog loop: each pass resumes from the previous traversal.
    let traversal: TranscriptProjectionPublicationOperations["preflight"]["output"]["traversal"];
    for (let pass = 0; pass < 3; pass++) {
      const status = await drainTranscriptIndexStatus(
        async () => transaction(db, () => maintainSessionTranscriptIndexStatus(db)),
        traversal,
      );
      if (status.traversalComplete) {
        expect(status.sessionIds).toEqual(["z-299"]);
        return;
      }
      traversal = status.traversal;
    }
    throw new Error("Backlog traversal never reached the late dirty session");
  } finally {
    siblingRevision.unknown = false;
  }
});
