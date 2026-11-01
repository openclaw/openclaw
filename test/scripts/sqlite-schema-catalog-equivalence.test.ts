import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, onTestFinished } from "vitest";
import { buildMemoryStorageSchema } from "../../packages/memory-host-sdk/src/host/memory-schema-base.js";
import { readSqliteSchemaCatalog as readNativeCatalog } from "../../scripts/lib/sqlite-schema-catalog.mts";
import { listSqliteSchemaInputs } from "../../scripts/lib/sqlite-schema-inputs.mts";
import { DAEMON_RUNTIME_PIN_SCHEMA_SQL } from "../../src/daemon/runtime-pin-schema.js";
import {
  collectSqliteSchemaIssues,
  createSqliteTableContractReader,
} from "../../src/infra/sqlite-schema-contract.js";
import { fingerprintSqliteSchemaCatalog } from "../../src/infra/sqlite-schema-fingerprint.js";
import { extractSqliteTableSchema } from "../../src/infra/sqlite-schema-sql.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../src/state/openclaw-agent-db-contract.js";
import { getOpenClawAgentMigrationSchema } from "../../src/state/openclaw-agent-schema-history.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../src/state/openclaw-agent-schema.js";
import { getOpenClawStateRuntimeSchema } from "../../src/state/openclaw-state-schema-runtime.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../src/state/openclaw-state-schema.js";
import {
  readGeneratedSqliteCatalog,
  readGeneratedSqliteFingerprint,
} from "../../src/state/postgres-schema.generated/sqlite-catalogs.js";

const inputs = listSqliteSchemaInputs();
const distinctInputs = [...new Map(inputs.map((input) => [input.sql, input])).values()];
function createDatabase(allowExtension = false) {
  const database = new DatabaseSync(":memory:", { allowExtension });
  onTestFinished(() => database.close());
  return database;
}

describe("generated SQLite schema catalogs", () => {
  it.each(distinctInputs)(
    "matches native catalog facts and admission for $id",
    async ({ sql, prepare }) => {
      const database = createDatabase(true);
      await prepare?.(database);
      database.exec(sql);
      const generated = readGeneratedSqliteCatalog(sql);
      const fingerprint = readGeneratedSqliteFingerprint(sql);
      // Native per-object PRAGMAs are independent of the batched runtime reader.
      const nativeCatalog = readNativeCatalog(database);
      expect(generated).toEqual(nativeCatalog);
      expect(
        createSqliteTableContractReader(database).readCatalog(
          nativeCatalog.views.map((view) => view.name),
          nativeCatalog.tables.map((table) => table.name),
        ),
      ).toEqual(generated);
      expect(fingerprintSqliteSchemaCatalog(nativeCatalog)).toBe(fingerprint?.fingerprint);
      expect(collectSqliteSchemaIssues(database, sql)).toEqual([]);
    },
  );

  it("covers expected definitions for fresh stores and every supported upgrade start", () => {
    const registeredSql = new Set(inputs.map(({ sql }) => sql));
    const expected = [
      OPENCLAW_STATE_SCHEMA_SQL,
      OPENCLAW_AGENT_SCHEMA_SQL,
      DAEMON_RUNTIME_PIN_SCHEMA_SQL,
    ];
    // Include pre-v8 non-session stores as well as released session layouts.
    for (let version = 1; version <= OPENCLAW_AGENT_SCHEMA_VERSION; version += 1) {
      expected.push(getOpenClawAgentMigrationSchema(version));
    }
    // Runtime projections depend on these flags, not individual migration versions.
    for (const includeVersionLazyAdditiveTables of [false, true]) {
      for (const includeAgentDeletionJournal of [false, true]) {
        expected.push(
          getOpenClawStateRuntimeSchema({
            includeVersionLazyAdditiveTables,
            includeAgentDeletionJournal,
          }),
        );
      }
    }

    for (const sql of expected) {
      expect(registeredSql.has(sql)).toBe(true);
      expect(readGeneratedSqliteFingerprint(sql)).toBeDefined();
    }
  });

  it.each([
    ["DEFAULT", "DEFAULT 'memory'", "DEFAULT 'sessions'", "column-definition-drift"],
    ["CHECK", "BETWEEN 1 AND 10", "BETWEEN 1 AND 9", "column-definition-drift"],
    ["unique key", "id TEXT NOT NULL UNIQUE", "id TEXT NOT NULL", "column-definition-drift"],
    ["index terms", "(path, source)", "(source, path)", "missing-or-drifted-index"],
  ])("rejects memory %s drift using the generated fragment", (_name, from, to, code) => {
    const schemaSql = buildMemoryStorageSchema({
      table: "memory_index_chunks",
      chunks: true,
      legacy: false,
      strict: true,
      inlineRecallColumns: ["importance"],
    });
    const database = createDatabase();
    database.exec(schemaSql.replace(from, to));
    expect(collectSqliteSchemaIssues(database, schemaSql)).toContainEqual(
      expect.objectContaining({ code }),
    );
  });

  it("keeps unrelated objects out of fragment fingerprints without hiding foreign uniqueness", () => {
    const sql = extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "schema_meta");
    const fingerprint = readGeneratedSqliteFingerprint(sql);
    const database = createDatabase();
    database.exec(sql);
    database.exec(`
        CREATE TABLE unrelated (id INTEGER PRIMARY KEY);
        CREATE VIEW unrelated_view AS SELECT id FROM unrelated;
        CREATE INDEX unrelated_lookup ON unrelated(id);
        CREATE INDEX metadata_lookup ON schema_meta(role);
      `);
    expect(fingerprintSqliteSchemaCatalog(readNativeCatalog(database), fingerprint)).toBe(
      fingerprint?.fingerprint,
    );
    expect(collectSqliteSchemaIssues(database, sql)).toEqual([]);

    database.exec("CREATE UNIQUE INDEX foreign_uniqueness ON schema_meta(role)");
    expect(fingerprintSqliteSchemaCatalog(readNativeCatalog(database), fingerprint)).not.toBe(
      fingerprint?.fingerprint,
    );
    expect(collectSqliteSchemaIssues(database, sql)).toContainEqual(
      expect.objectContaining({
        code: "unexpected-unique-index",
        objectName: "foreign_uniqueness",
      }),
    );
  });

  it.each`
    name                         | from                                               | to                                                 | code                            | objectName
    ${"DEFAULT value"}           | ${"snapshot_revision INTEGER NOT NULL DEFAULT 0"}  | ${"snapshot_revision INTEGER NOT NULL DEFAULT 1"}  | ${"column-definition-drift"}    | ${"session_nodes.snapshot_revision"}
    ${"CHECK expression"}        | ${"CHECK (entry_valid IN (-1, 0, 1))"}             | ${"CHECK (entry_valid IN (0, 1))"}                 | ${"column-definition-drift"}    | ${"session_nodes.entry_valid"}
    ${"partial-index predicate"} | ${"WHERE label IS NOT NULL;"}                      | ${"WHERE label IS NULL;"}                          | ${"missing-or-drifted-index"}   | ${"idx_agent_session_nodes_label"}
    ${"trigger body"}            | ${"SET snapshot_revision = snapshot_revision + 1"} | ${"SET snapshot_revision = snapshot_revision + 2"} | ${"missing-or-drifted-trigger"} | ${"session_entry_snapshots_after_insert"}
  `(
    "rejects $name drift through generated admission",
    ({
      from,
      to,
      code,
      objectName,
    }: {
      from: string;
      to: string;
      code: string;
      objectName: string;
    }) => {
      const database = createDatabase();
      const driftedSql = OPENCLAW_AGENT_SCHEMA_SQL.replace(from, to);
      expect(driftedSql).not.toBe(OPENCLAW_AGENT_SCHEMA_SQL);
      database.exec(driftedSql);
      expect(fingerprintSqliteSchemaCatalog(readNativeCatalog(database))).not.toBe(
        readGeneratedSqliteFingerprint(OPENCLAW_AGENT_SCHEMA_SQL)?.fingerprint,
      );
      expect(collectSqliteSchemaIssues(database, OPENCLAW_AGENT_SCHEMA_SQL)).toContainEqual(
        expect.objectContaining({ code, objectName }),
      );
    },
  );
});
