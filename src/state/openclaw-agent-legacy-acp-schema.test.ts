import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.test-support.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { AGENT_SCHEMA_COMPATIBILITY } from "./openclaw-agent-db-schema-compatibility.js";
import {
  ensureLegacyAcpMigrationProvenanceColumn,
  hasLegacyAcpMigrationProvenanceColumn,
} from "./openclaw-agent-legacy-acp-schema.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { tableHasColumn } from "./openclaw-state-db-schema-helpers.js";

const SESSION_SCHEMA = extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, "session_nodes");
const PREVIOUS_SESSION_SCHEMA = SESSION_SCHEMA.replace(
  /^\s*legacy_acp_migration_json[^\n]*\n/mu,
  "",
);
const row = (database: DatabaseSync, sql: string) => database.prepare(sql).get();
const version = (database: DatabaseSync) => row(database, "PRAGMA user_version");
const provenance = (database: DatabaseSync) =>
  row(database, "SELECT legacy_acp_migration_json FROM session_nodes");

function installProvenance(database: DatabaseSync, afterInstall = () => {}) {
  withSqlitePostCommitPublications(database, () =>
    runSqliteImmediateTransactionSync(database, () => {
      ensureLegacyAcpMigrationProvenanceColumn(database);
      afterInstall();
    }),
  );
}

afterEach(() => vi.restoreAllMocks());

function createDatabase(schema = PREVIOUS_SESSION_SCHEMA): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(schema);
  database.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}`);
  database
    .prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run("agent:main:legacy-acp", "legacy-acp-session", '{"sessionId":"legacy-acp-session"}', 1);
  return database;
}

describe("legacy ACP migration provenance schema", () => {
  it.each(["fresh", "first-use"] as const)(
    "keeps %s provenance compatible with older readers at the same schema version",
    (mode) => {
      using database = createDatabase(mode === "fresh" ? SESSION_SCHEMA : PREVIOUS_SESSION_SCHEMA);
      const original = row(database, "SELECT entry_json FROM session_nodes");
      installProvenance(database);
      const prepare = vi.spyOn(database, "prepare");
      expect(hasLegacyAcpMigrationProvenanceColumn(database)).toBe(true);
      ensureLegacyAcpMigrationProvenanceColumn(database);
      expect(prepare).not.toHaveBeenCalled();
      prepare.mockRestore();
      expect(
        database
          .prepare("PRAGMA table_info(session_nodes)")
          .all()
          .find((column) => column.name === "legacy_acp_migration_json"),
      ).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null, pk: 0 });
      expect(provenance(database)).toEqual({ legacy_acp_migration_json: null });
      expect(() =>
        assertSqliteSchemaContains(database, ":memory:", PREVIOUS_SESSION_SCHEMA, {
          allowCompatibleAdditiveColumns: true,
        }),
      ).not.toThrow();
      database
        .prepare("UPDATE session_nodes SET legacy_acp_migration_json = ?")
        .run('{"sourceKey":"fixture-source"}');
      database.prepare("UPDATE session_nodes SET label = ?").run("older-reader-edit");
      expect(provenance(database)).toEqual({
        legacy_acp_migration_json: '{"sourceKey":"fixture-source"}',
      });
      expect(row(database, "SELECT entry_json FROM session_nodes")).toEqual(original);
      expect(version(database)).toEqual({ user_version: OPENCLAW_AGENT_SCHEMA_VERSION });
    },
  );

  it("accepts the absent lazy column without mutating an old schema during reads", () => {
    using database = createDatabase();
    const schema = database.prepare("SELECT sql FROM sqlite_schema ORDER BY name").all();
    const rows = database.prepare("SELECT * FROM session_nodes").all();
    database.exec("PRAGMA query_only = ON");

    expect(hasLegacyAcpMigrationProvenanceColumn(database)).toBe(false);
    expect(() =>
      assertSqliteSchemaContains(database, ":memory:", SESSION_SCHEMA, AGENT_SCHEMA_COMPATIBILITY),
    ).not.toThrow();
    expect(database.prepare("SELECT sql FROM sqlite_schema ORDER BY name").all()).toEqual(schema);
    expect(database.prepare("SELECT * FROM session_nodes").all()).toEqual(rows);
    expect(version(database)).toEqual({ user_version: OPENCLAW_AGENT_SCHEMA_VERSION });
  });

  it("retries first-use DDL after rollback and keeps committed first use idempotent", () => {
    using database = createDatabase();
    const before = row(database, "PRAGMA schema_version");
    expect(() =>
      installProvenance(database, () => {
        expect(hasLegacyAcpMigrationProvenanceColumn(database)).toBe(true);
        throw new Error("abort provenance first use");
      }),
    ).toThrow("abort provenance first use");
    expect(row(database, "PRAGMA schema_version")).toEqual(before);
    expect(tableHasColumn(database, "session_nodes", "legacy_acp_migration_json")).toBe(false);
    expect(hasLegacyAcpMigrationProvenanceColumn(database)).toBe(false);

    installProvenance(database);
    expect(hasLegacyAcpMigrationProvenanceColumn(database)).toBe(true);
    expect(tableHasColumn(database, "session_nodes", "legacy_acp_migration_json")).toBe(true);
    const committed = row(database, "PRAGMA schema_version");
    ensureLegacyAcpMigrationProvenanceColumn(database);
    expect(row(database, "PRAGMA schema_version")).toEqual(committed);
    expect(version(database)).toEqual({ user_version: OPENCLAW_AGENT_SCHEMA_VERSION });
  });
});
