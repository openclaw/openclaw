import { copyFileSync, renameSync, symlinkSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "../infra/node-sqlite.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import { runSqlitePinnedReadSnapshotSync } from "../infra/sqlite-pinned-read-snapshot.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import {
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
} from "../infra/sqlite-transaction.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { persistAgentSchemaMetadata } from "./openclaw-agent-db-metadata-write.js";
import { readExistingAgentSchemaMeta } from "./openclaw-agent-db-metadata.js";
import { openOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly-open.js";
import { listOpenClawRegisteredAgentDatabases } from "./openclaw-agent-db-registry.js";
import { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";

const metadataSchema = `CREATE TABLE schema_meta (
  meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER,
  agent_id TEXT, app_version TEXT, created_at INTEGER, updated_at INTEGER
)`;

function validationStatements(queries: string[]): string[] {
  return queries.filter((sql) =>
    /sqlite_(?:schema|master)|pragma_(?:table|index|foreign_key)|\bPRAGMA\s+(?:user_version|schema_version|integrity_check|quick_check|foreign_key_check|table_info|table_xinfo|index_list|index_info|index_xinfo)\b|\bFROM\s+"?schema_meta\b/iu.test(
      sql,
    ),
  );
}

it.each(["transaction", "implicit snapshot"] as const)(
  "keeps agent metadata versions with their %s catalog",
  async (snapshot) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const filename = state.path("metadata.sqlite");
      using writer = openNodeSqliteDatabase(filename);
      writer.exec(`PRAGMA journal_mode=WAL; PRAGMA user_version=1; ${metadataSchema}`);
      admitSqliteSchema(writer);
      persistAgentSchemaMetadata(writer, "main", 1);
      using reader = openNodeSqliteDatabase(filename);
      const migrateWhileReading = () => {
        expect(reader.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
          schema_version: 1,
        });
        runSqliteImmediateTransactionSync(writer, () => {
          writer.exec("CREATE TABLE metadata_migration (id INTEGER); PRAGMA user_version=2");
          persistAgentSchemaMetadata(writer, "main", 2);
        });
        const observed = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
        try {
          expect(readExistingAgentSchemaMeta(reader)).toEqual({
            agentId: "main",
            role: "agent",
            schemaVersion: 1,
          });
          expect(observed.queries).toEqual([]);
        } finally {
          observed.restore();
        }
        expect(reader.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
          schema_version: 1,
        });
      };
      if (snapshot === "transaction") {
        runSqliteDeferredTransactionSync(reader, migrateWhileReading);
      } else {
        runSqlitePinnedReadSnapshotSync(reader, migrateWhileReading);
      }
      const observed = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
      try {
        expect(readExistingAgentSchemaMeta(reader)).toEqual({
          agentId: "main",
          role: "agent",
          schemaVersion: 2,
        });
        expect(observed.queries).toEqual([]);
      } finally {
        observed.restore();
      }
    });
  },
);

it.each(["drop", "recreate"] as const)(
  "rejects obsolete metadata after tracked storage %s and reuses the repaired publication",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const filename = state.path("metadata-storage.sqlite");
      using writer = openNodeSqliteDatabase(filename);
      writer.exec(`PRAGMA user_version=1; ${metadataSchema}`);
      admitSqliteSchema(writer);
      persistAgentSchemaMetadata(writer, "main", 1);
      expect(readExistingAgentSchemaMeta(writer)).toEqual({
        agentId: "main",
        role: "agent",
        schemaVersion: 1,
      });
      writer.exec(
        change === "drop" ? "DROP TABLE schema_meta" : `DROP TABLE schema_meta; ${metadataSchema}`,
      );
      expect(readExistingAgentSchemaMeta(writer)).toBeNull();
      if (change === "drop") {
        writer.exec(metadataSchema);
      }
      persistAgentSchemaMetadata(writer, "main", 1);
      using reopened = openNodeSqliteDatabase(filename);
      const observed = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
      try {
        for (const database of [writer, reopened]) {
          expect(readExistingAgentSchemaMeta(database)).toEqual({
            agentId: "main",
            role: "agent",
            schemaVersion: 1,
          });
        }
        expect(observed.queries).toEqual([]);
      } finally {
        observed.restore();
      }
    });
  },
);

it("reuses physical agent admission after reader opens and writer idle retirement", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const options = { agentId: "main", env };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const first = openOpenClawAgentDatabase(options);
      const firstNative = first.db;
      const observation = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
      try {
        const reader = openOpenClawAgentDatabaseReadOnly(options);
        expect(reader.found).toBe(true);
        if (reader.found) {
          reader.database.close();
        }
        vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
        expect(firstNative.isOpen).toBe(false);
        const reopened = openOpenClawAgentDatabase(options);
        expect(reopened.db === firstNative).toBe(false);
        expect(reopened.db.isOpen).toBe(true);
        expect(validationStatements(observation.queries)).toEqual([]);
      } finally {
        observation.restore();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

it("keeps a tracked sibling's committed catalog when reopening an admitted agent", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const options = { agentId: "main", env };
    const first = openOpenClawAgentDatabase(options);
    await closeOpenClawAgentDatabaseByPathAsync(first.path);
    using sibling = openNodeSqliteDatabase(first.path);
    sibling.exec("CREATE TABLE adoption_probe (id INTEGER); INSERT INTO adoption_probe VALUES (1)");
    expect(getAdmittedSqliteSchemaFacts(sibling)?.tables.has("adoption_probe")).toBe(true);
    const reopened = openOpenClawAgentDatabase(options);
    expect(getAdmittedSqliteSchemaFacts(reopened.db)?.tables.has("adoption_probe")).toBe(true);
    expect(reopened.db.prepare("SELECT id FROM adoption_probe").all()).toEqual([{ id: 1 }]);
    using witness = openNodeSqliteDatabase(first.path);
    expect(getAdmittedSqliteSchemaFacts(witness)?.tables.has("adoption_probe")).toBe(true);
    await closeOpenClawAgentDatabaseByPathAsync(first.path);
    const observed = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
    try {
      const warm = openOpenClawAgentDatabase(options);
      expect(getAdmittedSqliteSchemaFacts(warm.db)?.tables.has("adoption_probe")).toBe(true);
      expect(validationStatements(observed.queries)).toEqual([]);
    } finally {
      observed.restore();
    }
  });
});

it("validates a replacement agent file even when the pathname was admitted", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const options = { agentId: "main", env };
    const first = openOpenClawAgentDatabase(options);
    await closeOpenClawAgentDatabaseByPathAsync(first.path);
    const replacement = `${first.path}.replacement`;
    copyFileSync(first.path, replacement);
    const raw = new (requireNodeSqlite().DatabaseSync)(replacement);
    raw.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1}`);
    raw.close();
    renameSync(replacement, first.path);
    const observation = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
    try {
      expect(() => openOpenClawAgentDatabaseReadOnly(options)).toThrow(/newer schema version/iu);
      expect(validationStatements(observation.queries).length).toBeGreaterThan(0);
    } finally {
      observation.restore();
    }
  });
});

it.each(["tracked", "raw"] as const)(
  "retains admission only from tracked maintenance after registration (%s)",
  async (opener) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const options = { agentId: "main", env };
      const first = openOpenClawAgentDatabase(options);
      first.db.exec(`INSERT INTO auth_profile_state (state_key, state_json, updated_at)
        VALUES ('maintenance-handoff', '{"preserved":true}', 1)`);
      await closeOpenClawAgentDatabaseByPathAsync(first.path);
      {
        using database =
          opener === "tracked"
            ? openNodeSqliteDatabase(first.path)
            : new (requireNodeSqlite().DatabaseSync)(first.path);
        ensureOpenClawAgentDatabaseSchema(database, {
          ...options,
          path: first.path,
          register: true,
        });
      }
      expect(listOpenClawRegisteredAgentDatabases({ env })).toContainEqual(
        expect.objectContaining({ agentId: "main", path: first.path }),
      );
      const observation = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
      try {
        const reopened = openOpenClawAgentDatabase(options);
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
      } finally {
        observation.restore();
      }
    });
  },
);

it("registers a new alias without repeating the physical database admission", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", env: state.env };
    const first = openOpenClawAgentDatabase(options);
    const aliasDirectory = state.path("agent-alias");
    symlinkSync(path.dirname(first.path), aliasDirectory, "junction");
    const aliasPath = path.join(aliasDirectory, path.basename(first.path));
    const observation = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
    try {
      const alias = openOpenClawAgentDatabase({ ...options, path: aliasPath });
      expect(alias.db.isOpen).toBe(true);
      expect(validationStatements(observation.queries)).toEqual([]);
    } finally {
      observation.restore();
    }
    expect(
      listOpenClawRegisteredAgentDatabases({ env: state.env }).map((row) => row.path),
    ).toContain(aliasPath);
  });
});
