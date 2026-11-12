import { createHash } from "node:crypto";
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
import { withLegacyWorkspaceBootstrapDeferred } from "../../src/state/openclaw-state-db-schema-v40-lazy-additions.js";
import { withLegacyWorkerProvisionSource } from "../../src/state/openclaw-state-db-schema-v40-worker-provision-source.js";
import {
  getOpenClawStateRuntimeSchema,
  getOpenClawStatePredecessorSchema,
} from "../../src/state/openclaw-state-schema-runtime.js";
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

  it("keeps predecessor schemas free of objects introduced after their version", () => {
    // A state schema edit without a matching predecessor transform retires every
    // derived hash, stranding real databases on the previous layout.
    const predecessor39 = getOpenClawStatePredecessorSchema(39);
    expect(predecessor39).not.toContain(
      "CREATE TABLE IF NOT EXISTS device_pairing_browser_requests",
    );
    expect(predecessor39).not.toContain("bootstrap_deferred");
    expect(readGeneratedSqliteFingerprint(predecessor39)).toBeDefined();
    expect(readGeneratedSqliteCatalog(predecessor39)).toBeDefined();
  });

  it.each([
    [false, false, "d867544f0eef2a762dc9051ea0e15b8091c270bbb2a73b4903ecd0928e04aaef"],
    [false, true, "413ccc65b8a2461f1b8a0d51d1b5dcf815a0adbe5f2d6d9639096b9217deccb4"],
    [true, false, "18180a4cb062b9b3a7591243f04344a87a771d9c15ed915ec0d5613f0fc90f02"],
    [true, true, "49992d8ed832224f1aa240a8453cc509cdcebadc48879674be554c8c02d5f902"],
  ] as const)("retains the pre-browser-request runtime projection %s/%s", (lazy, journal, hash) => {
    const options = {
      includeVersionLazyAdditiveTables: lazy,
      includeAgentDeletionJournal: journal,
    };
    const current = getOpenClawStateRuntimeSchema(options);
    const historical = getOpenClawStateRuntimeSchema(
      options,
      getOpenClawStatePredecessorSchema(39),
    );
    expect(createHash("sha256").update(historical).digest("hex")).toBe(hash);
    expect(readGeneratedSqliteCatalog(historical)).toBeDefined();
    expect(getOpenClawStateRuntimeSchema(options)).toBe(current);
  });

  it.each([
    [undefined, "3e69be25aa64d744c4dbe3a82aeb19e282e4921b53ebc3c530c3961f9971a078"],
    [[false, false], "1e0d269930a1d67272f2abba63d124b3334e409e0c70da34ef1f7fb0f6c77401"],
    [[false, true], "70a1959c27096a3bce2f88f145b5b7cb334cb23b0c319d6bd8d4dcfb9c872e14"],
    [[true, false], "002d221c278c58836d140db820dcbef0d7f59933caa80a9d0b6bb6df735e7004"],
    [[true, true], "609552a7a9cc616c87500badcdae12dfae764bf0fb12758d249265c9475d5ede"],
  ] as const)(
    "keeps the pre-provision-source catalog readable after a build swap (%s)",
    (flags, hash) => {
      const predecessor = withLegacyWorkerProvisionSource(OPENCLAW_STATE_SCHEMA_SQL);
      const historical = flags
        ? getOpenClawStateRuntimeSchema(
            { includeVersionLazyAdditiveTables: flags[0], includeAgentDeletionJournal: flags[1] },
            predecessor,
          )
        : predecessor;
      // These are the actual source hashes embedded in the immediately preceding build.
      expect(createHash("sha256").update(historical).digest("hex")).toBe(hash);
      expect(readGeneratedSqliteCatalog(historical)).toBeDefined();
      expect(readGeneratedSqliteFingerprint(historical)).toBeDefined();
    },
  );

  it("retains the runtime between browser pairing and deferred bootstrap", () => {
    const options = { includeVersionLazyAdditiveTables: true, includeAgentDeletionJournal: true };
    const current = getOpenClawStateRuntimeSchema(options);
    const historical = getOpenClawStateRuntimeSchema(
      options,
      withLegacyWorkspaceBootstrapDeferred(
        withLegacyWorkerProvisionSource(OPENCLAW_STATE_SCHEMA_SQL),
      ),
    );
    expect(createHash("sha256").update(historical).digest("hex")).toBe(
      "afbcc7fdd91f9a30199ca909e0429d8faf48ab2c4ed4c97e8e967920f76b5e52",
    );
    expect(historical).toContain("CREATE TABLE IF NOT EXISTS device_pairing_browser_requests");
    expect(readGeneratedSqliteCatalog(historical)).toBeDefined();
    expect(getOpenClawStateRuntimeSchema(options)).toBe(current);
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
