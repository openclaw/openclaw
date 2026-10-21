import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync, StatementSync, constants as SQL } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { probeSqliteIteratorBehavior } from "../infra/sqlite-native-observer.js";
import { runSqliteSchemaReadSnapshotSync } from "../infra/sqlite-pinned-read-snapshot.js";
import {
  admitSqliteSchema,
  runSqliteReadOperationSync as readOperation,
  trackSqliteSchema,
} from "../infra/sqlite-schema-facts.js";
import { readExistingAgentSchemaMeta as readAgentMeta } from "./openclaw-agent-db-metadata.js";
import { assertOpenClawStateDatabaseOwner } from "./openclaw-state-db-maintenance.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function authorize(db: DatabaseSync, action: number, name: string, decision = SQL.SQLITE_DENY) {
  db.setAuthorizer((op, object) => (op === action && object === name ? decision : SQL.SQLITE_OK));
}

function createMetadata(role: string, location = ":memory:"): DatabaseSync {
  const database = new DatabaseSync(location);
  database.exec(
    "CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER, agent_id TEXT, app_version TEXT)",
  );
  database
    .prepare("INSERT INTO schema_meta VALUES ('primary', ?, 1, ?, NULL)")
    .run(role, role === "agent" ? "main" : null);
  return database;
}

describe.each(["agent", "global"] as const)("%s schema metadata", (role) => {
  const read =
    role === "agent"
      ? readAgentMeta
      : (database: DatabaseSync) =>
          assertOpenClawStateDatabaseOwner(database, { pathname: "fixture.sqlite" });
  it("reads historical metadata without probing columns on success", () => {
    using database = createMetadata(role);
    database.exec("ALTER TABLE schema_meta DROP COLUMN app_version");
    authorize(database, SQL.SQLITE_PRAGMA, "table_info");
    expect(() => read(database)).not.toThrow();
  });

  it.each(["missing", "denied", "EIO", "SQL", "inspect-failed", "inspect-ignored"])(
    "classifies %s without turning native failures into schema refusals",
    (failure) => {
      using database = createMetadata(role);
      const error = Object.assign(new Error("synthetic native read failure"), {
        code: "ERR_SQLITE_ERROR",
        errcode: failure === "EIO" ? 10 : 1,
      });
      const prepare = database.prepare.bind(database);
      const nativeFailure = failure === "missing" || failure === "denied";
      if (!nativeFailure) {
        vi.spyOn(database, "prepare").mockImplementation((sql, ...args) => {
          if (sql.includes("FROM schema_meta")) {
            throw error;
          }
          if (failure === "inspect-failed" && sql.includes("table_info")) {
            throw new Error("synthetic inspection failure");
          }
          return prepare(sql, ...args);
        });
      }
      if (failure === "missing") {
        const column = role === "agent" ? "agent_id" : "schema_version";
        database.exec(`ALTER TABLE schema_meta RENAME COLUMN ${column} TO retired_${column}`);
        expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } else if (failure === "denied") {
        authorize(database, SQL.SQLITE_READ, "schema_meta");
      } else if (failure === "inspect-ignored") {
        authorize(database, SQL.SQLITE_PRAGMA, "table_info", SQL.SQLITE_IGNORE);
      }
      const cause = { code: "ERR_SQLITE_ERROR", errcode: 1 };
      const expected =
        failure === "missing"
          ? { name: "SqliteSchemaMismatchError", cause }
          : { name: "Error", code: "ERR_SQLITE_ERROR", errcode: 23 };
      const check = (observed: unknown) => {
        if (nativeFailure) {
          expect(observed).toMatchObject(expected);
        } else {
          expect(observed).toBe(error);
        }
        return true;
      };
      assert.throws(() => read(database), check);
    },
  );
});

it("keeps absent agent ownership separate from malformed metadata", () => {
  using database = new DatabaseSync(":memory:");
  expect(readAgentMeta(database)).toBeNull();
  database.exec(
    "CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER, agent_id TEXT)",
  );
  expect(readAgentMeta(database)).toBeNull();
});

it.each(["transaction", "pinned snapshot"] as const)(
  "keeps raw ownership reads within a %s and observes foreign ownership after release",
  (snapshot) => {
    const filename = path.join(tempDirs.make("openclaw-schema-metadata-"), "agent.sqlite");
    using writer = createMetadata("agent", filename);
    writer.exec("PRAGMA journal_mode=WAL");
    using reader = new DatabaseSync(filename, { readOnly: true });
    const read = () => readOperation(reader, () => readAgentMeta(reader));
    const observation = observeSqliteReadSql(StatementSync.prototype);
    const metadataReads = () =>
      observation.queries.filter((sql) => /^SELECT role, schema_version, agent_id/iu.test(sql));
    const readSnapshot = () => {
      expect([read()?.agentId, read()?.agentId]).toEqual(["main", "main"]);
      writer.exec("UPDATE schema_meta SET agent_id = 'foreign'");
      expect(read()?.agentId).toBe("main");
      expect(metadataReads()).toHaveLength(3);
    };
    if (snapshot === "transaction") {
      reader.exec("BEGIN");
      try {
        readSnapshot();
      } finally {
        reader.exec("ROLLBACK");
      }
    } else {
      runSqliteSchemaReadSnapshotSync(reader, readSnapshot);
    }
    expect([read()?.agentId, read()?.agentId]).toEqual(["foreign", "foreign"]);
    expect(metadataReads()).toHaveLength(5);
  },
);

it("keeps admitted ownership current through local writes, rollback, and authorizers", () => {
  using database = createMetadata("agent");
  database.exec(`CREATE TABLE selected_owner (agent_id TEXT);
    CREATE TRIGGER replace_owner AFTER INSERT ON selected_owner
      BEGIN UPDATE schema_meta SET agent_id = new.agent_id; END;`);
  trackSqliteSchema(database, {
    DatabaseSync,
    StatementSync,
    iteratorBehavior: probeSqliteIteratorBehavior(database.prepare("SELECT 1")),
  });
  admitSqliteSchema(database);
  const read = () => readOperation(database, () => readAgentMeta(database));
  const first = read();
  assert(first);
  expect(first.agentId).toBe("main");
  first.agentId = "caller-copy";
  expect(read()?.agentId).toBe("main");
  database.exec("UPDATE schema_meta SET agent_id = 'local'");
  expect(read()?.agentId).toBe("local");
  database.exec("BEGIN; UPDATE schema_meta SET agent_id = 'temporary'");
  expect(read()?.agentId).toBe("temporary");
  database.prepare("INSERT INTO selected_owner VALUES (?)").run("triggered");
  expect(read()?.agentId).toBe("triggered");
  database.exec("ROLLBACK");
  expect(read()?.agentId).toBe("local");
  let allowRead = true;
  database.setAuthorizer((action, table) =>
    !allowRead && action === SQL.SQLITE_READ && table === "schema_meta"
      ? SQL.SQLITE_DENY
      : SQL.SQLITE_OK,
  );
  expect(read()?.agentId).toBe("local");
  allowRead = false;
  expect(read).toThrow();
  database.setAuthorizer(null);
  expect(read()?.agentId).toBe("local");
});
