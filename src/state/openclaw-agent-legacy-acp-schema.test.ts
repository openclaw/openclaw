import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { assertOpenClawAgentSchemaContains } from "./openclaw-agent-db-schema-helpers.js";
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
const databases: DatabaseSync[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) {
    database.close();
  }
});

function createDatabase(schema = PREVIOUS_SESSION_SCHEMA): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
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
      const database = createDatabase(mode === "fresh" ? SESSION_SCHEMA : PREVIOUS_SESSION_SCHEMA);
      const original = database.prepare("SELECT entry_json FROM session_nodes").get();
      withSqlitePostCommitPublications(database, () =>
        runSqliteImmediateTransactionSync(database, () => {
          ensureLegacyAcpMigrationProvenanceColumn(database);
        }),
      );
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
      expect(database.prepare("SELECT legacy_acp_migration_json FROM session_nodes").get()).toEqual(
        {
          legacy_acp_migration_json: null,
        },
      );
      expect(() =>
        assertSqliteSchemaContains(database, ":memory:", PREVIOUS_SESSION_SCHEMA, {
          allowCompatibleAdditiveColumns: true,
        }),
      ).not.toThrow();
      database
        .prepare("UPDATE session_nodes SET legacy_acp_migration_json = ?")
        .run('{"sourceKey":"fixture-source"}');
      database.prepare("UPDATE session_nodes SET label = ?").run("older-reader-edit");
      expect(database.prepare("SELECT legacy_acp_migration_json FROM session_nodes").get()).toEqual(
        {
          legacy_acp_migration_json: '{"sourceKey":"fixture-source"}',
        },
      );
      expect(database.prepare("SELECT entry_json FROM session_nodes").get()).toEqual(original);
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
    },
  );

  it("accepts the absent lazy column without mutating an old schema during reads", () => {
    const database = createDatabase();
    const schema = database.prepare("SELECT sql FROM sqlite_schema ORDER BY name").all();
    const rows = database.prepare("SELECT * FROM session_nodes").all();
    database.exec("PRAGMA query_only = ON");

    expect(hasLegacyAcpMigrationProvenanceColumn(database)).toBe(false);
    expect(() =>
      assertOpenClawAgentSchemaContains(database, ":memory:", SESSION_SCHEMA),
    ).not.toThrow();
    expect(database.prepare("SELECT sql FROM sqlite_schema ORDER BY name").all()).toEqual(schema);
    expect(database.prepare("SELECT * FROM session_nodes").all()).toEqual(rows);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
  });

  it("retries first-use DDL after rollback and keeps committed first use idempotent", () => {
    const database = createDatabase();
    const before = database.prepare("PRAGMA schema_version").get();
    expect(() =>
      withSqlitePostCommitPublications(database, () =>
        runSqliteImmediateTransactionSync(database, () => {
          ensureLegacyAcpMigrationProvenanceColumn(database);
          expect(hasLegacyAcpMigrationProvenanceColumn(database)).toBe(true);
          throw new Error("abort provenance first use");
        }),
      ),
    ).toThrow("abort provenance first use");
    expect(database.prepare("PRAGMA schema_version").get()).toEqual(before);
    expect(tableHasColumn(database, "session_nodes", "legacy_acp_migration_json")).toBe(false);
    expect(hasLegacyAcpMigrationProvenanceColumn(database)).toBe(false);

    withSqlitePostCommitPublications(database, () =>
      runSqliteImmediateTransactionSync(database, () => {
        ensureLegacyAcpMigrationProvenanceColumn(database);
      }),
    );
    expect(hasLegacyAcpMigrationProvenanceColumn(database)).toBe(true);
    expect(tableHasColumn(database, "session_nodes", "legacy_acp_migration_json")).toBe(true);
    const committed = database.prepare("PRAGMA schema_version").get();
    ensureLegacyAcpMigrationProvenanceColumn(database);
    expect(database.prepare("PRAGMA schema_version").get()).toEqual(committed);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
  });
});
