import path from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import { admitSqliteSchema, runSqliteReadOperationSync } from "../../infra/sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync as immediate } from "../../infra/sqlite-transaction.js";
import {
  createSessionEntryRevisionGuard,
  readSessionEntryCacheValidityToken,
} from "./session-accessor.sqlite-entry-revision.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const databases: DatabaseSync[] = [];
const staleFacts = "Prepared session entry facts are no longer current";
afterEach(() => {
  for (const database of databases.splice(0).toReversed()) {
    database.close();
  }
});

function openDatabase(filename = ":memory:") {
  const db = openNodeSqliteDatabase(filename);
  databases.push(db);
  return db;
}

it.skipIf(typeof DatabaseSync.prototype.setAuthorizer !== "function")(
  "refuses cached receipts when an authorizer revokes schema admission",
  () => {
    const { database: db } = guardFixture();
    const token = () =>
      runSqliteReadOperationSync(db, () => readSessionEntryCacheValidityToken(db));
    const initial = token();
    db.setAuthorizer((action, table) =>
      action === constants.SQLITE_READ && table === "session_nodes"
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK,
    );
    try {
      expect(token).toThrow("SQLite session entry caching requires admitted schema facts");
    } finally {
      db.setAuthorizer(null);
    }
    admitSqliteSchema(db);
    expect(token()).toEqual(initial);
  },
);
function guardFixture(filename = ":memory:") {
  const database = openDatabase(filename);
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
      withSqlitePostCommitPublications(database, () => immediate(database, operation)),
  };
}

it("checks local writes, rollback, and released authority", () => {
  const { database, guard, transaction, release } = guardFixture();
  const schemaVersion = readSessionEntryCacheValidityToken(database).schemaVersion;
  transaction(() => {
    guard();
    expect(() =>
      transaction(() => {
        database.exec("UPDATE session_nodes SET writer = 'revoked'");
        expect(guard).toThrow(staleFacts);
        throw new Error("rollback nested write");
      }),
    ).toThrow("rollback nested write");
    expect(guard).not.toThrow();
  });
  expect(guard).not.toThrow();
  release();
  expect(guard).toThrow("source released");
  database.exec("ALTER TABLE session_nodes ADD COLUMN revision_probe TEXT");
  admitSqliteSchema(database);
  expect(readSessionEntryCacheValidityToken(database).schemaVersion).toBeGreaterThan(schemaVersion);
});

it("observes a sibling writer receipt before the next authority check", () => {
  const filename = path.join(tempDirs.make("session-revision-sibling-"), "agent.sqlite");
  const { database, guard, transaction } = guardFixture(filename);
  const writer = openDatabase(filename);
  runSqliteReadOperationSync(database, () => {
    writer.exec("UPDATE session_nodes SET writer = 'superseded'");
    expect(() => transaction(guard)).toThrow(staleFacts);
  });
  expect(guard).toThrow(staleFacts);
});

it("checks the next predicate after a sibling commit overlaps a read", () => {
  const filename = path.join(tempDirs.make("session-revision-overlap-"), "agent.sqlite");
  const { database } = guardFixture(filename);
  database.exec("PRAGMA journal_mode = WAL");
  const writer = openDatabase(filename);
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
  expect(guard).toThrow(staleFacts);
});
