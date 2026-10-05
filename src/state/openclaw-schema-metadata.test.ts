import { DatabaseSync, StatementSync, constants } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
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

function createMetadata(role: string): DatabaseSync {
  const database = new DatabaseSync(":memory:");
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

it("keeps admitted ownership current through local writes, rollback, and authorizers", () => {
  const database = createMetadata("agent");
  trackSqliteSchema(database, { DatabaseSync, StatementSync });
  admitSqliteSchema(database);
  const read = () =>
    runSqliteReadOperationSync(database, () => readExistingAgentSchemaMeta(database), "fresh");
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
    database.exec("ROLLBACK");
    expect(read()?.agentId).toBe("local");
    database.setAuthorizer((action, table) =>
      action === constants.SQLITE_READ && table === "schema_meta"
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK,
    );
    expect(read).toThrow();
    database.setAuthorizer(null);
    expect(read()?.agentId).toBe("local");
  } finally {
    database.close();
  }
});
