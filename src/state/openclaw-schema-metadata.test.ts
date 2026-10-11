import path from "node:path";
import { DatabaseSync, StatementSync, constants } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { probeSqliteIteratorBehavior } from "../infra/sqlite-native-observer.js";
import { runSqliteSchemaReadSnapshotSync } from "../infra/sqlite-pinned-read-snapshot.js";
import {
  admitSqliteSchema,
  runSqliteReadOperationSync,
  trackSqliteSchema,
} from "../infra/sqlite-schema-facts.js";
import { SqliteSchemaMismatchError } from "../infra/sqlite-schema-issues.js";
import { readExistingAgentSchemaMeta } from "./openclaw-agent-db-metadata.js";
import { assertOpenClawStateDatabaseOwner } from "./openclaw-state-db-maintenance.js";

const readers = [
  { role: "agent", read: readExistingAgentSchemaMeta },
  {
    role: "global",
    read: (database: DatabaseSync) =>
      assertOpenClawStateDatabaseOwner(database, { pathname: "fixture.sqlite" }),
  },
] as const;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createMetadata(role: string, location = ":memory:"): DatabaseSync {
  const database = new DatabaseSync(location);
  database.exec(`
    CREATE TABLE schema_meta (
      meta_key TEXT PRIMARY KEY, role TEXT NOT NULL, schema_version INTEGER NOT NULL,
      agent_id TEXT, app_version TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  database
    .prepare("INSERT INTO schema_meta VALUES ('primary', ?, 1, ?, NULL, 1, 1)")
    .run(role, role === "agent" ? "main" : null);
  return database;
}

describe.each(readers)("$role schema metadata", ({ role, read }) => {
  it("reads historical metadata without probing columns on success", () => {
    const database = createMetadata(role);
    try {
      database.exec("ALTER TABLE schema_meta DROP COLUMN app_version");
      database.setAuthorizer((action, name) =>
        action === constants.SQLITE_PRAGMA && name === "table_info"
          ? constants.SQLITE_DENY
          : constants.SQLITE_OK,
      );
      expect(() => read(database)).not.toThrow();
    } finally {
      database.close();
    }
  });

  it.each([
    "missing column",
    "authorization",
    "EIO",
    "unrelated SQL",
    "failed inspection",
    "ignored inspection",
  ])("classifies %s without turning native failures into schema refusals", (failure) => {
    const database = createMetadata(role);
    const error = Object.assign(new Error("synthetic native read failure"), {
      code: "ERR_SQLITE_ERROR",
      errcode: failure === "EIO" ? 10 : 1,
    });
    const prepare = database.prepare.bind(database);
    const nativeFailure = failure === "missing column" || failure === "authorization";
    const stub = nativeFailure
      ? undefined
      : vi.spyOn(database, "prepare").mockImplementation((sql, ...args) => {
          if (sql.includes("FROM schema_meta")) {
            throw error;
          }
          if (failure === "failed inspection" && sql.includes("table_info")) {
            throw new Error("synthetic inspection failure");
          }
          return prepare(sql, ...args);
        });
    try {
      if (failure === "missing column") {
        const column = role === "agent" ? "agent_id" : "schema_version";
        database.exec(`ALTER TABLE schema_meta RENAME COLUMN ${column} TO retired_${column}`);
        expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } else if (failure === "authorization") {
        database.setAuthorizer((action, table) =>
          action === constants.SQLITE_READ && table === "schema_meta"
            ? constants.SQLITE_DENY
            : constants.SQLITE_OK,
        );
      } else if (failure === "ignored inspection") {
        database.setAuthorizer((action, name) =>
          action === constants.SQLITE_PRAGMA && name === "table_info"
            ? constants.SQLITE_IGNORE
            : constants.SQLITE_OK,
        );
      }
      if (failure === "missing column") {
        expect(() => read(database)).toThrowError(
          expect.objectContaining({
            name: "SqliteSchemaMismatchError",
            cause: expect.objectContaining({ code: "ERR_SQLITE_ERROR", errcode: 1 }),
          }),
        );
      } else if (failure === "authorization") {
        expect(() => read(database)).toThrowError(
          expect.objectContaining({
            name: "Error",
            code: "ERR_SQLITE_ERROR",
            errcode: 23,
          }),
        );
      } else {
        let observed: unknown;
        try {
          read(database);
        } catch (caught) {
          observed = caught;
        }
        expect(observed).toBe(error);
        expect(observed).not.toBeInstanceOf(SqliteSchemaMismatchError);
      }
    } finally {
      stub?.mockRestore();
      database.close();
    }
  });
});

it("keeps absent agent ownership separate from malformed metadata", () => {
  const database = new DatabaseSync(":memory:");
  try {
    expect(readExistingAgentSchemaMeta(database)).toBeNull();
    database.exec(
      "CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER, agent_id TEXT)",
    );
    expect(readExistingAgentSchemaMeta(database)).toBeNull();
  } finally {
    database.close();
  }
});

it.each(["transaction", "pinned snapshot"] as const)(
  "keeps raw ownership reads within a %s and observes foreign ownership after release",
  (snapshot) => {
    const filename = path.join(tempDirs.make("openclaw-schema-metadata-"), "agent.sqlite");
    const writer = createMetadata("agent", filename);
    writer.exec("PRAGMA journal_mode=WAL");
    const reader = new DatabaseSync(filename, { readOnly: true });
    const read = () =>
      runSqliteReadOperationSync(reader, () => readExistingAgentSchemaMeta(reader));
    const observation = observeSqliteReadSql(StatementSync.prototype);
    const metadataReads = () =>
      observation.queries.filter((sql) => /^SELECT role, schema_version, agent_id/iu.test(sql));
    try {
      const readSnapshot = () => {
        expect(read()?.agentId).toBe("main");
        expect(read()?.agentId).toBe("main");
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
      expect(read()?.agentId).toBe("foreign");
      expect(read()?.agentId).toBe("foreign");
      expect(metadataReads()).toHaveLength(5);
    } finally {
      observation.restore();
      reader.close();
      writer.close();
    }
  },
);

it("keeps admitted ownership current through local writes, rollback, and authorizers", () => {
  const database = createMetadata("agent");
  database.exec(`
    CREATE TABLE selected_owner (agent_id TEXT);
    CREATE TRIGGER replace_owner AFTER INSERT ON selected_owner
      BEGIN UPDATE schema_meta SET agent_id = new.agent_id; END;
  `);
  trackSqliteSchema(
    database,
    {
      DatabaseSync,
      StatementSync,
      iteratorBehavior: probeSqliteIteratorBehavior(database.prepare("SELECT 1")),
    },
    true,
  );
  admitSqliteSchema(database);
  const read = () =>
    runSqliteReadOperationSync(database, () => readExistingAgentSchemaMeta(database));
  try {
    const first = read();
    expect(first?.agentId).toBe("main");
    if (first) {
      first.agentId = "caller-copy";
    }
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
      !allowRead && action === constants.SQLITE_READ && table === "schema_meta"
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK,
    );
    expect(read()?.agentId).toBe("local");
    allowRead = false;
    expect(read).toThrow();
    database.setAuthorizer(null);
    expect(read()?.agentId).toBe("local");
  } finally {
    database.close();
  }
});
