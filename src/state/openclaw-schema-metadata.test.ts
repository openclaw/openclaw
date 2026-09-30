import { DatabaseSync, constants } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
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
  it.each(
    role === "agent"
      ? ["meta_key", "role", "schema_version", "agent_id"]
      : ["meta_key", "role", "schema_version"],
  )("classifies an absent %s column from healthy SQLite as a schema refusal", (column) => {
    const database = createMetadata(role);
    try {
      database.exec(`ALTER TABLE schema_meta RENAME COLUMN ${column} TO retired_${column}`);
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(() => read(database)).toThrowError(
        expect.objectContaining({
          name: "SqliteSchemaMismatchError",
          cause: expect.objectContaining({ code: "ERR_SQLITE_ERROR", errcode: 1 }),
        }),
      );
    } finally {
      database.close();
    }
  });

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

  it("preserves a native authorization refusal", () => {
    const database = createMetadata(role);
    try {
      database.setAuthorizer((action, table) =>
        action === constants.SQLITE_READ && table === "schema_meta"
          ? constants.SQLITE_DENY
          : constants.SQLITE_OK,
      );
      expect(() => read(database)).toThrowError(
        expect.objectContaining({ name: "Error", code: "ERR_SQLITE_ERROR", errcode: 23 }),
      );
    } finally {
      database.close();
    }
  });

  it.each(["EIO", "ENOSPC", "unrelated SQL", "failed inspection", "ignored inspection"])(
    "preserves the original %s read failure",
    (failure) => {
      const database = createMetadata(role);
      const error = Object.assign(new Error("synthetic native read failure"), {
        code: "ERR_SQLITE_ERROR",
        errcode: failure === "EIO" ? 10 : failure === "ENOSPC" ? 13 : 1,
      });
      const prepare = database.prepare.bind(database);
      const stub = vi.spyOn(database, "prepare").mockImplementation((sql, ...args) => {
        if (sql.includes("FROM schema_meta")) {
          throw error;
        }
        if (failure === "failed inspection" && sql.includes("table_info")) {
          throw new Error("synthetic inspection failure");
        }
        return prepare(sql, ...args);
      });
      try {
        if (failure === "ignored inspection") {
          database.setAuthorizer((action, name) =>
            action === constants.SQLITE_PRAGMA && name === "table_info"
              ? constants.SQLITE_IGNORE
              : constants.SQLITE_OK,
          );
        }
        let observed: unknown;
        try {
          read(database);
        } catch (caught) {
          observed = caught;
        }
        expect(observed).toBe(error);
        expect(observed).not.toBeInstanceOf(SqliteSchemaMismatchError);
      } finally {
        stub.mockRestore();
        database.close();
      }
    },
  );
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
