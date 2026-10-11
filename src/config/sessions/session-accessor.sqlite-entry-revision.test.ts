import path from "node:path";
import { constants, DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  observeSqliteReadSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import { admitSqliteSchema, runSqliteReadOperationSync } from "../../infra/sqlite-schema-facts.js";
import {
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
  runSqliteReadSnapshotSync,
} from "../../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../state/openclaw-agent-schema.js";
import {
  createSessionEntryRevisionGuard,
  readSessionEntryCacheValidityToken,
  readSessionNodesGeneration,
} from "./session-accessor.sqlite-entry-revision.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0).toReversed()) {
    database.close();
  }
});

function fixture(filename = ":memory:") {
  const db = openNodeSqliteDatabase(filename);
  databases.push(db);
  db.exec(`BEGIN; ${OPENCLAW_AGENT_SCHEMA_SQL}
    INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
    VALUES ('agent:main:revision', 'revision', '{}', 1);
    COMMIT;`);
  admitSqliteSchema(db);
  const read = () => runSqliteReadOperationSync(db, () => readSessionNodesGeneration(db));
  const token = () => runSqliteReadOperationSync(db, () => readSessionEntryCacheValidityToken(db));
  expect(read()).toBe(0);
  return { db, read, token };
}

describe("session entry revision facts", () => {
  it("reads connection-owned generations without SQL after reads and row writes", () => {
    const { db, read } = fixture();
    // The first read installs TEMP triggers; admit that schema before observing warm reads.
    expect(read()).toBe(0);
    const observation = observeSqliteReadSql(StatementSync.prototype);
    try {
      expect(read()).toBe(0);
      db.exec("UPDATE session_nodes SET updated_at = 2");
      const changed = read();
      expect(changed).toBeGreaterThan(0);
      expect(read()).toBe(changed);
      runSqliteDeferredTransactionSync(db, () => {
        expect(read()).toBe(changed);
        expect(read()).toBe(changed);
      });
      expect(read()).toBe(changed);
      expect(observation.queries.filter((sql) => /\bdata_version\b/iu.test(sql))).toEqual([]);
      expect(
        observation.queries.filter((sql) =>
          sql.includes('"openclaw_session_nodes_cache_generation"'),
        ),
      ).toHaveLength(0);
    } finally {
      observation.restore();
    }
  });

  it("invalidates entry and participant snapshots after writes and rollback", () => {
    const { db, read } = fixture();
    db.exec("UPDATE session_nodes SET updated_at = 2");
    const updated = read();
    expect(updated).toBeGreaterThan(0);
    let committed = updated;
    runSqliteDeferredTransactionSync(db, () => {
      db.exec("SAVEPOINT revision_change");
      db.prepare(
        `INSERT INTO session_participants
        (session_key, identity_namespace, actor_id, contribution_count)
        VALUES ('agent:main:revision', 'test', 'actor', 1)`,
      ).run();
      const uncommitted = read();
      expect(uncommitted).toBeGreaterThan(updated);
      db.exec("ROLLBACK TO SAVEPOINT revision_change; RELEASE SAVEPOINT revision_change");
      expect(read()).toBeGreaterThan(uncommitted);
      db.exec("UPDATE session_nodes SET updated_at = 3");
      committed = read();
      expect(committed).toBeGreaterThan(updated);
    });
    expect(read()).toBe(committed);
    db.exec("BEGIN; UPDATE session_nodes SET updated_at = 4");
    const uncommitted = read();
    expect(uncommitted).toBeGreaterThan(committed);
    db.exec("ROLLBACK");
    const rolledBack = read();
    expect(rolledBack).toBeGreaterThan(uncommitted);
    expect(read()).toBe(rolledBack);
    db.exec("ALTER TABLE session_nodes ADD COLUMN revision_probe TEXT");
    admitSqliteSchema(db);
    expect(read()).toBeGreaterThan(rolledBack);
    const insideBatch: number[] = [];
    db.function("capture_generation", () => {
      insideBatch.push(read());
      return null;
    });
    db.exec(`BEGIN; UPDATE session_nodes SET updated_at = 5;
      SELECT capture_generation(); ROLLBACK; SELECT capture_generation();`);
    expect(insideBatch[1]).toBeGreaterThan(insideBatch[0]!);
    expect(read()).toBeGreaterThan(insideBatch[1]!);
  });

  it("observes sibling receipts while native reads retain their explicit snapshot", () => {
    const filename = path.join(tempDirs.make("entry-revision-"), "agent.sqlite");
    const { db, token } = fixture(filename);
    db.exec("PRAGMA journal_mode=WAL");
    const peer = openNodeSqliteDatabase(filename);
    databases.push(peer);
    const initial = token();
    peer.exec("UPDATE session_nodes SET updated_at = 2");
    const changed = token();
    expect(changed.siblingWriteRevision).not.toBe(initial.siblingWriteRevision);
    expect(changed.sessionNodesGeneration).toBe(initial.sessionNodesGeneration);
    runSqliteReadSnapshotSync(db, () => {
      const read = () => db.prepare("SELECT updated_at FROM session_nodes").get()?.updated_at;
      expect(read()).toBe(2);
      peer.exec("UPDATE session_nodes SET updated_at = 3");
      expect(token().siblingWriteRevision).not.toBe(changed.siblingWriteRevision);
      expect(read()).toBe(2);
    });
    expect(token().siblingWriteRevision).not.toBe(changed.siblingWriteRevision);
  });

  it.skipIf(typeof DatabaseSync.prototype.setAuthorizer !== "function")(
    "refuses generation reuse when an authorizer revokes schema admission",
    () => {
      const { db, read } = fixture();
      db.setAuthorizer((action, table) =>
        action === constants.SQLITE_READ && table === "openclaw_session_nodes_cache_generation"
          ? constants.SQLITE_DENY
          : constants.SQLITE_OK,
      );
      try {
        expect(read).toThrow("SQLite session entry caching requires admitted schema facts");
      } finally {
        db.setAuthorizer(null);
      }
      admitSqliteSchema(db);
      expect(read()).toBe(0);
    },
  );
});

function guardFixture(filename = ":memory:") {
  const database = openNodeSqliteDatabase(filename);
  databases.push(database);
  database.exec("CREATE TABLE session_nodes (id INTEGER PRIMARY KEY, writer TEXT)");
  database.exec("INSERT INTO session_nodes VALUES (1, 'current')");
  admitSqliteSchema(database);
  let current = true;
  const guard = createSessionEntryRevisionGuard(
    database,
    () => {
      if (!current) {
        throw new Error("source released");
      }
    },
    () =>
      database.prepare("SELECT writer FROM session_nodes WHERE id = 1").get()?.writer === "current",
  );
  guard();
  return {
    database,
    guard,
    release: () => {
      current = false;
    },
    transaction: <T>(operation: () => T) =>
      withSqlitePostCommitPublications(database, () =>
        runSqliteImmediateTransactionSync(database, operation),
      ),
  };
}

it("checks local writes, rollback, and released authority without freshness SQL", () => {
  const { database, guard, transaction, release } = guardFixture();
  const sql = trackSqliteStatementExecutions(database, ["fresh"], (statement) =>
    /^PRAGMA data_version$|FROM main\.pragma_data_version\(\)\s*$/iu.test(statement.trim())
      ? "fresh"
      : null,
  );
  try {
    transaction(() => {
      guard();
      guard();
      expect(() =>
        transaction(() => {
          database.exec("UPDATE session_nodes SET writer = 'revoked'");
          expect(guard).toThrow("Prepared session entry facts are no longer current");
          throw new Error("rollback nested write");
        }),
      ).toThrow("rollback nested write");
      expect(guard).not.toThrow();
      expect(sql.counts.fresh).toBe(0);
    });
    expect(guard).not.toThrow();
    expect(sql.counts.fresh).toBe(0);
    release();
    expect(guard).toThrow("source released");
  } finally {
    sql.restore();
  }
});

it("observes a sibling writer receipt before the next authority check", () => {
  const filename = path.join(tempDirs.make("session-revision-sibling-"), "agent.sqlite");
  const { database, guard, transaction } = guardFixture(filename);
  const writer = openNodeSqliteDatabase(filename);
  databases.push(writer);
  runSqliteReadOperationSync(database, () => {
    writer.exec("UPDATE session_nodes SET writer = 'superseded'");
    expect(() => transaction(guard)).toThrow("Prepared session entry facts are no longer current");
  });
  expect(guard).toThrow("Prepared session entry facts are no longer current");
});

it("checks the next predicate after a sibling commit overlaps a read", () => {
  const filename = path.join(tempDirs.make("session-revision-overlap-"), "agent.sqlite");
  const { database } = guardFixture(filename);
  database.exec("PRAGMA journal_mode = WAL");
  const writer = openNodeSqliteDatabase(filename);
  databases.push(writer);
  writer.exec("BEGIN IMMEDIATE; UPDATE session_nodes SET writer = 'superseded'");
  let first = true;
  const guard = createSessionEntryRevisionGuard(
    database,
    () => {},
    () => {
      const matches =
        database.prepare("SELECT writer FROM session_nodes").get()?.writer === "current";
      if (first) {
        first = false;
        writer.exec("COMMIT");
      }
      return matches;
    },
  );
  expect(guard).not.toThrow();
  expect(guard).toThrow("Prepared session entry facts are no longer current");
});
