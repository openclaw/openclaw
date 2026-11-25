import { copyFileSync, renameSync } from "node:fs";
import { expect, it as baseIt } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "../infra/node-sqlite.js";
import { runSqliteSchemaReadSnapshotSync } from "../infra/sqlite-pinned-read-snapshot.js";
import {
  admitSqliteSchema,
  getAdmittedSqliteSchemaFacts as schemaFacts,
} from "../infra/sqlite-schema-facts.js";
import {
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
} from "../infra/sqlite-transaction.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { persistAgentSchemaMetadata as persistMetadata } from "./openclaw-agent-db-metadata-write.js";
import { readExistingAgentSchemaMeta as readMetadata } from "./openclaw-agent-db-metadata.js";
import { openOpenClawAgentDatabaseReadOnly as openReader } from "./openclaw-agent-db-readonly-open.js";
import { listOpenClawRegisteredAgentDatabases as registeredAgents } from "./openclaw-agent-db-registry.js";
import { ensureOpenClawAgentDatabaseSchema as ensureAgentSchema } from "./openclaw-agent-db-schema.js";
import {
  closeOpenClawAgentDatabaseByPathAsync as closeAgent,
  openOpenClawAgentDatabase as openAgent,
} from "./openclaw-agent-db.js";
import { readOpenClawDatabaseQuarantineFailure as quarantineFailure } from "./openclaw-quarantine-store.js";
import { resolveQuarantineStorePath } from "./openclaw-state-db.paths.js";

const metadataSchema = `CREATE TABLE schema_meta (
  meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER,
  agent_id TEXT, app_version TEXT, created_at INTEGER, updated_at INTEGER
)`;

const it = baseIt.extend<{ state: OpenClawTestState }>({
  state: async ({ task: _task }, use) => withOpenClawTestState({ scenario: "minimal" }, use),
});

function validationStatements(queries: string[]): string[] {
  return queries.filter((sql) =>
    /sqlite_(?:schema|master)|pragma_(?:table|index|foreign_key)|\bPRAGMA\s+(?:user_version|schema_version|integrity_check|quick_check|foreign_key_check|table_info|table_xinfo|index_list|index_info|index_xinfo)\b|\bFROM\s+"?schema_meta\b/iu.test(
      sql,
    ),
  );
}

function observeReads() {
  const observation = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
  return { ...observation, [Symbol.dispose]: () => observation.restore() };
}

function expectCachedMetadata(database: Parameters<typeof readMetadata>[0], schemaVersion: number) {
  using observed = observeReads();
  expect(readMetadata(database)).toEqual({ agentId: "main", role: "agent", schemaVersion });
  expect(observed.queries).toEqual([]);
}

function admitQuarantine(
  database: Parameters<typeof admitSqliteSchema>[0],
  agentPath: string,
  env: NodeJS.ProcessEnv,
) {
  admitSqliteSchema(database);
  expect(quarantineFailure("agent", agentPath, { env })).toBeUndefined();
}

it.for(["transaction", "implicit snapshot"] as const)(
  "keeps agent metadata versions with their %s catalog",
  async (snapshot, { state }) => {
    const filename = state.path("metadata.sqlite");
    using writer = openNodeSqliteDatabase(filename);
    writer.exec(`PRAGMA journal_mode=WAL; PRAGMA user_version=1; ${metadataSchema}`);
    admitSqliteSchema(writer);
    persistMetadata(writer, "main", 1);
    using reader = openNodeSqliteDatabase(filename);
    const migrateWhileReading = () => {
      expect(reader.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
        schema_version: 1,
      });
      runSqliteImmediateTransactionSync(writer, () => {
        writer.exec("CREATE TABLE metadata_migration (id INTEGER); PRAGMA user_version=2");
        persistMetadata(writer, "main", 2);
      });
      {
        using observed = observeReads();
        expect(readMetadata(reader)).toEqual({ agentId: "main", role: "agent", schemaVersion: 1 });
        // Only the explicit schema cursor proves its catalog before the sibling DDL.
        expect(observed.queries).toHaveLength(snapshot === "transaction" ? 4 : 0);
      }
      expectCachedMetadata(reader, 1);
      expect(reader.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
        schema_version: 1,
      });
    };
    if (snapshot === "transaction") {
      runSqliteDeferredTransactionSync(reader, migrateWhileReading);
    } else {
      runSqliteSchemaReadSnapshotSync(reader, migrateWhileReading);
    }
    expectCachedMetadata(reader, 2);
  },
);

it.for(["drop", "recreate"] as const)(
  "rejects obsolete metadata after tracked storage %s and reuses the repaired publication",
  async (change, { state }) => {
    const filename = state.path("metadata-storage.sqlite");
    using writer = openNodeSqliteDatabase(filename);
    writer.exec(`PRAGMA user_version=1; ${metadataSchema}`);
    admitSqliteSchema(writer);
    persistMetadata(writer, "main", 1);
    expect(readMetadata(writer)).toEqual({ agentId: "main", role: "agent", schemaVersion: 1 });
    writer.exec(
      change === "drop" ? "DROP TABLE schema_meta" : `DROP TABLE schema_meta; ${metadataSchema}`,
    );
    expect(readMetadata(writer)).toBeNull();
    if (change === "drop") {
      writer.exec(metadataSchema);
    }
    persistMetadata(writer, "main", 1);
    using reopened = openNodeSqliteDatabase(filename);
    for (const database of [writer, reopened]) {
      expectCachedMetadata(database, 1);
    }
  },
);

it("reuses closed-writer ownership for read-only admission until tracked schema changes", async ({
  state: { env },
}) => {
  const options = { agentId: "main", env };
  const owner = openAgent(options);
  await closeAgent(owner.path);
  {
    using observation = observeReads();
    const reader = openReader(options);
    try {
      expect(reader.found).toBe(true);
      expect(observation.queries.filter((sql) => /\bFROM\s+"?schema_meta\b/iu.test(sql))).toEqual(
        [],
      );
    } finally {
      if (reader.found) {
        reader.database.close();
      }
    }
  }
  using writer = openNodeSqliteDatabase(owner.path);
  writer.exec("DROP TABLE session_canonical_validation_pending");
  expect(() => openReader(options)).toThrow(
    expect.objectContaining({
      name: "SessionMetadataUnavailableError",
      reason: "table-missing",
      missingTables: ["session_canonical_validation_pending"],
    }),
  );
});

it("keeps a tracked sibling's committed catalog when reopening an admitted agent", async ({
  state: { env },
}) => {
  const options = { agentId: "main", env };
  const first = openAgent(options);
  using quarantine = openNodeSqliteDatabase(resolveQuarantineStorePath(env), { readOnly: true });
  admitQuarantine(quarantine, first.path, env);
  await closeAgent(first.path);
  using sibling = openNodeSqliteDatabase(first.path);
  admitSqliteSchema(sibling);
  sibling.exec("CREATE TABLE adoption_probe (id INTEGER); INSERT INTO adoption_probe VALUES (1)");
  expect(schemaFacts(sibling)?.tables.has("adoption_probe")).toBe(true);
  const reopened = openAgent(options);
  expect(schemaFacts(reopened.db)?.tables.has("adoption_probe")).toBe(true);
  expect(reopened.db.prepare("SELECT id FROM adoption_probe").all()).toEqual([{ id: 1 }]);
  using witness = openNodeSqliteDatabase(first.path);
  expect(schemaFacts(witness)?.tables.has("adoption_probe")).toBe(true);
  await closeAgent(first.path);
  using observed = observeReads();
  const warm = openAgent(options);
  expect(schemaFacts(warm.db)?.tables.has("adoption_probe")).toBe(true);
  expect(validationStatements(observed.queries)).toEqual([]);
});

it("validates a replacement agent file even when the pathname was admitted", async ({
  state: { env },
}) => {
  const options = { agentId: "main", env };
  const first = openAgent(options);
  await closeAgent(first.path);
  const replacement = `${first.path}.replacement`;
  copyFileSync(first.path, replacement);
  const raw = new (requireNodeSqlite().DatabaseSync)(replacement);
  raw.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1};
    UPDATE schema_meta SET app_version = '2026.10.8' WHERE meta_key = 'primary'`);
  raw.close();
  renameSync(replacement, first.path);
  using observation = observeReads();
  expect(() => openReader(options)).toThrow(/OpenClaw 2026\.10\.8;.*doctor --fix/isu);
  expect(validationStatements(observation.queries).length).toBeGreaterThan(0);
});

it.for(["tracked", "raw"] as const)(
  "retains admission only from tracked maintenance after registration (%s)",
  async (opener, { state: { env } }) => {
    const options = { agentId: "main", env };
    const first = openAgent(options);
    using quarantine = openNodeSqliteDatabase(resolveQuarantineStorePath(env), { readOnly: true });
    admitQuarantine(quarantine, first.path, env);
    first.db.exec(`INSERT INTO auth_profile_state (state_key, state_json, updated_at)
        VALUES ('maintenance-handoff', '{"preserved":true}', 1)`);
    await closeAgent(first.path);
    using database =
      opener === "tracked"
        ? openNodeSqliteDatabase(first.path)
        : new (requireNodeSqlite().DatabaseSync)(first.path);
    ensureAgentSchema(database, { ...options, path: first.path, register: true });
    expect(registeredAgents({ env })).toContainEqual(
      expect.objectContaining({ agentId: "main", path: first.path }),
    );
    {
      using observation = observeReads();
      const reopened = openAgent(options);
      expect(reopened.path).toBe(first.path);
      if (opener === "tracked") {
        expect(validationStatements(observation.queries)).toEqual([]);
      } else {
        expect(validationStatements(observation.queries).length).toBeGreaterThan(0);
      }
      expect(
        reopened.db
          .prepare(
            "SELECT state_json FROM auth_profile_state WHERE state_key = 'maintenance-handoff'",
          )
          .get(),
      ).toEqual({ state_json: '{"preserved":true}' });
    }
  },
);
