import { execFileSync } from "node:child_process";
import path from "node:path";
import { constants, DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  observeSqliteReadSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { runSqlitePinnedReadSnapshotSync } from "../../infra/sqlite-pinned-read-snapshot.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import { admitSqliteSchema, runSqliteReadOperationSync } from "../../infra/sqlite-schema-facts.js";
import {
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
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
  it("reuses unchanged generation reads across admitted operations and read transactions", () => {
    const { db, read } = fixture();
    // The first read installs TEMP triggers; admit that schema before observing warm reads.
    expect(read()).toBe(0);
    const observation = observeSqliteReadSql(StatementSync.prototype);
    try {
      expect(read()).toBe(0);
      expect(read()).toBe(0);
      runSqliteDeferredTransactionSync(db, () => {
        expect(read()).toBe(0);
        expect(read()).toBe(0);
      });
      expect(read()).toBe(0);
      expect(
        observation.queries.filter((sql) =>
          sql.includes('"openclaw_session_nodes_cache_generation"'),
        ),
      ).toHaveLength(0);
    } finally {
      observation.restore();
    }
  });

  it("observes raw entry and participant writes and discards rolled-back generations", () => {
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
      expect(read()).toBeGreaterThan(updated);
      db.exec("ROLLBACK TO SAVEPOINT revision_change; RELEASE SAVEPOINT revision_change");
      expect(read()).toBe(updated);
      db.exec("UPDATE session_nodes SET updated_at = 3");
      committed = read();
      expect(committed).toBeGreaterThan(updated);
    });
    expect(read()).toBe(committed);
    db.exec("BEGIN; UPDATE session_nodes SET updated_at = 4");
    expect(read()).toBeGreaterThan(committed);
    db.exec("ROLLBACK");
    expect(read()).toBe(committed);
    db.exec("ALTER TABLE session_nodes ADD COLUMN revision_probe TEXT");
    admitSqliteSchema(db);
    expect(read()).toBeGreaterThan(committed);
  });

  it("keeps foreign-commit revisions fenced by their pinned snapshot", () => {
    const filename = path.join(tempDirs.make("entry-revision-"), "agent.sqlite");
    const { db, token } = fixture(filename);
    db.exec("PRAGMA journal_mode=WAL");
    const peer = new DatabaseSync(filename);
    databases.push(peer);
    const initial = token();
    peer.exec("UPDATE session_nodes SET updated_at = 2");
    const changed = token();
    expect(changed.dataVersion).not.toBe(initial.dataVersion);
    expect(changed.sessionNodesGeneration).toBe(initial.sessionNodesGeneration);
    runSqlitePinnedReadSnapshotSync(db, () => {
      const pinned = token();
      peer.exec("UPDATE session_nodes SET updated_at = 3");
      expect(token()).toEqual(pinned);
    });
    expect(token().dataVersion).not.toBe(changed.dataVersion);
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

it("shares transaction freshness while detecting local writes, rollback, and released authority", () => {
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
      expect(sql.counts.fresh).toBe(1);
    });
    expect(guard).not.toThrow();
    expect(sql.counts.fresh).toBe(2);
    release();
    expect(guard).toThrow("source released");
  } finally {
    sql.restore();
  }
});

it("observes a foreign process commit after read admission before the next transaction", () => {
  const filename = path.join(tempDirs.make("session-revision-foreign-"), "agent.sqlite");
  const { database, guard, transaction } = guardFixture(filename);
  runSqliteReadOperationSync(database, () => {
    // The old unpinned scope cannot certify the snapshot acquired by the later BEGIN.
    execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec(\"UPDATE session_nodes SET writer = 'foreign'\"); db.close();",
      filename,
    ]);
    expect(() => transaction(guard)).toThrow("Prepared session entry facts are no longer current");
  });
  expect(guard).toThrow("Prepared session entry facts are no longer current");
});
