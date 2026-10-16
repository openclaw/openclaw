import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
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
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../src/state/openclaw-state-db-contract.js";
import { getOpenClawStateRuntimeSchema } from "../../src/state/openclaw-state-schema-runtime.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../src/state/openclaw-state-schema.js";
import {
  readGeneratedSqliteCatalog,
  readGeneratedSqliteFingerprint,
} from "../../src/state/postgres-schema.generated/sqlite-catalogs.js";

const inputs = listSqliteSchemaInputs();
const distinctInputs = [...new Map(inputs.map((input) => [input.sql, input])).values()];

describe("generated SQLite schema catalogs", () => {
  it.each(distinctInputs)("matches native catalog facts and admission for $id", ({ sql }) => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(sql);
      const generated = readGeneratedSqliteCatalog(sql);
      const fingerprint = readGeneratedSqliteFingerprint(sql);
      expect(generated).toBeDefined();
      expect(fingerprint).toBeDefined();
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
    } finally {
      database.close();
    }
  });

  it("covers expected definitions for fresh stores and every supported upgrade start", () => {
    const registeredSql = new Set(inputs.map(({ sql }) => sql));
    const requireCatalog = (sql: string, label: string) => {
      expect(registeredSql.has(sql), label).toBe(true);
      expect(readGeneratedSqliteFingerprint(sql), label).toBeDefined();
    };
    requireCatalog(OPENCLAW_STATE_SCHEMA_SQL, "fresh state");
    requireCatalog(OPENCLAW_AGENT_SCHEMA_SQL, "fresh agent");
    requireCatalog(DAEMON_RUNTIME_PIN_SCHEMA_SQL, "daemon runtime pins v1");

    // Shared-state migration preflights use the canonical definition with versioned
    // compatibility rules; creation/repair projects only the tables it may create.
    for (let version = 1; version <= OPENCLAW_STATE_SCHEMA_VERSION; version += 1) {
      requireCatalog(OPENCLAW_STATE_SCHEMA_SQL, `state v${version} preflight`);
      for (const includeAgentDeletionJournal of [false, true]) {
        requireCatalog(
          getOpenClawStateRuntimeSchema({
            includeVersionLazyAdditiveTables: version < OPENCLAW_STATE_SCHEMA_VERSION,
            includeAgentDeletionJournal,
          }),
          `state v${version} runtime, journal=${includeAgentDeletionJournal}`,
        );
      }
    }

    // Pre-v8 non-session databases remain supported; released session layouts start at v8.
    // These are the expected-definition contracts, not fabricated historical stores.
    for (let version = 1; version <= OPENCLAW_AGENT_SCHEMA_VERSION; version += 1) {
      requireCatalog(getOpenClawAgentMigrationSchema(version), `agent v${version}`);
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
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(schemaSql.replace(from, to));
      expect(collectSqliteSchemaIssues(database, schemaSql)).toContainEqual(
        expect.objectContaining({ code }),
      );
    } finally {
      database.close();
    }
  });

  it("keeps unrelated objects out of fragment fingerprints without hiding foreign uniqueness", () => {
    const sql = extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "schema_meta");
    const fingerprint = readGeneratedSqliteFingerprint(sql);
    expect(fingerprint).toBeDefined();
    const database = new DatabaseSync(":memory:");
    try {
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
    } finally {
      database.close();
    }
  });

  it.each([
    {
      name: "DEFAULT value",
      from: "snapshot_revision INTEGER NOT NULL DEFAULT 0",
      to: "snapshot_revision INTEGER NOT NULL DEFAULT 1",
      code: "column-definition-drift",
      objectName: "session_nodes.snapshot_revision",
    },
    {
      name: "CHECK expression",
      from: "CHECK (entry_valid IN (-1, 0, 1))",
      to: "CHECK (entry_valid IN (0, 1))",
      code: "column-definition-drift",
      objectName: "session_nodes.entry_valid",
    },
    {
      name: "partial-index predicate",
      from: "WHERE label IS NOT NULL;",
      to: "WHERE label IS NULL;",
      code: "missing-or-drifted-index",
      objectName: "idx_agent_session_nodes_label",
    },
    {
      name: "trigger body",
      from: "SET snapshot_revision = snapshot_revision + 1",
      to: "SET snapshot_revision = snapshot_revision + 2",
      code: "missing-or-drifted-trigger",
      objectName: "session_entry_snapshots_after_insert",
    },
  ])("rejects $name drift through generated admission", ({ from, to, code, objectName }) => {
    const database = new DatabaseSync(":memory:");
    try {
      const driftedSql = OPENCLAW_AGENT_SCHEMA_SQL.replace(from, to);
      expect(driftedSql).not.toBe(OPENCLAW_AGENT_SCHEMA_SQL);
      database.exec(driftedSql);
      expect(fingerprintSqliteSchemaCatalog(readNativeCatalog(database))).not.toBe(
        readGeneratedSqliteFingerprint(OPENCLAW_AGENT_SCHEMA_SQL)?.fingerprint,
      );
      expect(collectSqliteSchemaIssues(database, OPENCLAW_AGENT_SCHEMA_SQL)).toContainEqual(
        expect.objectContaining({ code, objectName }),
      );
    } finally {
      database.close();
    }
  });
});
