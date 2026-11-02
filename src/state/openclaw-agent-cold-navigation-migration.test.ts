import { constants, type DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "../infra/node-sqlite.js";
import { runSqliteIntegrityCheckSync } from "../infra/sqlite-integrity.js";
import { captureSqliteSchemaFacts } from "../infra/sqlite-schema-admission.js";
import { parseSqliteTableDefinition } from "../infra/sqlite-schema-contract-assembly.js";
import {
  extractSqliteTableSchema,
  normalizeSqlWhitespace,
  quoteSqliteIdentifier,
} from "../infra/sqlite-schema-sql.js";
import { AGENT_COLD_NAVIGATION_SCHEMA_VERSION as target } from "./openclaw-agent-db-contract.js";
import { assertOpenClawAgentCurrentRuntimeSchema } from "./openclaw-agent-db-schema-helpers.js";
import { agentDatabaseIntegrityBeforeMutationSteps } from "./openclaw-agent-db-schema.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { assertOpenClawMigrationWitnessPreserved } from "./openclaw-migration-witness.js";
import {
  resolveSchemaMigrationBackupTables,
  resolveSchemaMigrationIntegrityCheck,
} from "./schema-migration-backup-scope.js";
import {
  agentWitness,
  expectVersion,
  migrationFixture,
  row,
  rows,
  seedAgentV38Schema,
} from "./schema-migration.test-support.js";

const navigation = JSON.stringify({
  version: 1,
  report: { kind: "ignored" },
  navigation: {},
  reset: {},
  model: {},
  modelBytes: 0,
  modelWithoutCheckpointBytes: 0,
  withoutCustomDataBytes: 0,
});
const predecessor = 38;
const scope = ["schema_meta", "transcript_events"];

function seed(database: DatabaseSync): void {
  seedAgentV38Schema(database);
  database.exec(`
    PRAGMA foreign_keys = ON;
    INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
      VALUES ('agent:main:retained', 'hot', '{"sessionId":"hot","updatedAt":1}', 1);
    INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
      VALUES ('hot', 'agent:main:retained', 1, 1), ('cold', 'agent:main:retained', 1, 1);
    INSERT INTO transcript_events (rowid, session_id, seq, event_json, created_at)
      VALUES (9007199254740993, 'hot', 1, ' {"type":"message","message":{"role":"user"}} ', 1);
    INSERT INTO transcript_event_identities (session_id, event_id, seq, created_at)
      VALUES ('hot', 'retained-id', 1, 1);
    INSERT INTO session_transcript_active_events (session_id, active_position, event_seq)
      VALUES ('hot', 0, 1);
    INSERT INTO session_transcript_cold_archives
      (session_id, generation, archive_name, archive_sha256, event_count, raw_bytes,
       archive_bytes, last_seq, archived_at, storage, archive_blob)
      VALUES ('cold', 'generation', 'retained.jsonl.zst', '${"a".repeat(64)}',
        1, 7, 3, 1, 1, 'sqlite', X'0011FF');
    INSERT INTO cache_entries (scope, key, blob, updated_at)
      VALUES ('unrelated', 'bytes', X'000100FF', 1);
    WITH RECURSIVE n(i) AS (VALUES(3) UNION ALL SELECT i+1 FROM n WHERE i<34)
    INSERT INTO transcript_events (rowid, session_id, seq, event_zstd, event_utf8_bytes, navigation_json, created_at)
      SELECT i, 'hot', i, zeroblob(65536), 65536, '${navigation}', 1 FROM n;
    ANALYZE;
  `);
  database
    .prepare(`INSERT INTO transcript_events
    (rowid, session_id, seq, event_zstd, event_utf8_bytes, navigation_json, created_at)
    VALUES (2, 'hot', 2, X'0011FF', 123, ?, 2)`)
    .run(navigation);
}

const withFixture = migrationFixture({ seed, predecessor, target, scope });
const insertCold = (database: DatabaseSync, length: number | null = 123) =>
  database
    .prepare(`INSERT INTO transcript_events
    (rowid, session_id, seq, event_utf8_bytes, navigation_json, created_at)
    VALUES (1, 'cold', 1, ?, ?, 1)`)
    .run(length, navigation);

it.each(["commit", "rollback"])(
  "preserves hot bytes, rowids, children and archives on %s",
  async (outcome) => {
    await withFixture("cold-navigation.sqlite", async ({ database, migrate }) => {
      expect(() => insertCold(database)).toThrow(/CHECK constraint/u);
      const witness = agentWitness(database);
      const original = row(
        database,
        "SELECT CAST(rowid AS TEXT) AS id, event_json FROM transcript_events WHERE seq = 1",
      );
      const physical = () => ({
        root: row(database, "SELECT rootpage FROM sqlite_schema WHERE name = 'transcript_events'"),
        pages: Number(row(database, "PRAGMA page_count")?.page_count),
      });
      const before = physical();
      const created: string[] = [];
      if (outcome === "commit") {
        database.setAuthorizer((action, name) => {
          if (action === constants.SQLITE_CREATE_TABLE) {
            created.push(name ?? "");
          }
          return constants.SQLITE_OK;
        });
      }
      await migrate(outcome);
      expect(physical().root).toEqual(before.root);
      expect(physical().pages).toBeLessThanOrEqual(before.pages + 2);
      expect(created).toEqual([]);
      expectVersion(database, outcome === "commit" ? target : predecessor);
      expect(assertOpenClawMigrationWitnessPreserved(witness, agentWitness(database))).toEqual({
        warnings: [],
      });
      expect(
        row(
          database,
          "SELECT CAST(rowid AS TEXT) AS id, event_json FROM transcript_events WHERE seq = 1",
        ),
      ).toEqual(original);
      expect(rows(database, "PRAGMA foreign_key_check")).toEqual([]);
      if (outcome === "rollback") {
        expect(() => insertCold(database)).toThrow(/CHECK constraint/u);
        return;
      }
      for (const invalid of [null, 0, 4194305]) {
        expect(() => insertCold(database, invalid)).toThrow(/CHECK constraint/u);
      }
      insertCold(database);
      expect(
        row(
          database,
          "SELECT event_json, event_zstd, event_utf8_bytes FROM transcript_events WHERE session_id = 'cold'",
        ),
      ).toEqual({ event_json: null, event_zstd: null, event_utf8_bytes: 123 });
    });
  },
);

it("converges with the original rebuild catalog and runtime admission", async () => {
  using rebuilt = openNodeSqliteDatabase(":memory:");
  seed(rebuilt);
  const facts = captureSqliteSchemaFacts(rebuilt);
  const source = facts.tableSql.get("transcript_events")!;
  const next = parseSqliteTableDefinition(
    extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, "transcript_events"),
    "transcript_events",
  ).constraints.find((constraint) => constraint.includes("event_zstd IS NOT NULL"))!;
  const previous = parseSqliteTableDefinition(source, "transcript_events").constraints.find(
    (constraint) => constraint.includes("event_zstd IS NOT NULL"),
  )!;
  const columns = [...parseSqliteTableDefinition(source, "transcript_events").columns.keys()]
    .map(quoteSqliteIdentifier)
    .join(", ");
  // Frozen schema-39 rebuild sequence from #188397, including SQLite's RENAME quoting.
  rebuilt.exec(`PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;
    ${normalizeSqlWhitespace(source)
      .replace(
        /^CREATE TABLE (?:IF NOT EXISTS )?(?:"transcript_events"|transcript_events)/u,
        "CREATE TABLE transcript_events_cold_navigation_migration",
      )
      .replace(previous, next)};
    INSERT INTO transcript_events_cold_navigation_migration (rowid, ${columns})
      SELECT rowid, ${columns} FROM transcript_events;
    DROP TABLE transcript_events;
    ALTER TABLE transcript_events_cold_navigation_migration RENAME TO transcript_events;`);
  for (const object of [...facts.indexDefinitions.values(), ...facts.triggers.values()]) {
    if (object.table === "transcript_events" && object.sql) {
      rebuilt.exec(object.sql);
    }
  }
  rebuilt.exec(`PRAGMA user_version=39; UPDATE schema_meta SET schema_version=39; COMMIT;`);
  await withFixture("convergence.sqlite", async ({ database, migrate }) => {
    await migrate();
    const {
      admissionId: _id,
      revision: _revision,
      schemaVersion: _version,
      ...expected
    } = captureSqliteSchemaFacts(rebuilt);
    expect(captureSqliteSchemaFacts(database)).toMatchObject(expected);
    for (const db of [rebuilt, database]) {
      expect(() =>
        assertOpenClawAgentCurrentRuntimeSchema(db, {
          agentId: "main",
          pathname: "convergence.sqlite",
        }),
      ).not.toThrow();
    }
    const migration = {
      kind: "agent" as const,
      foundVersion: predecessor,
      supportedVersion: target,
    };
    expect(resolveSchemaMigrationBackupTables(migration)).toEqual(scope);
    expect(resolveSchemaMigrationIntegrityCheck(migration)).toMatchObject({
      check: "quick",
      tables: expect.arrayContaining(["schema_meta"]),
    });
    expect(resolveSchemaMigrationIntegrityCheck(migration).tables).not.toEqual(
      expect.arrayContaining(["transcript_events"]),
    );
  });
});

it("restores the scoped predecessor without discarding unrelated later writes", async () => {
  await withFixture(
    "cold-navigation-restore.sqlite",
    async ({ database, restore }) => {
      await restore(() => ({
        definition: row(database, "SELECT sql FROM sqlite_schema WHERE name = 'transcript_events'"),
        version: row(database, "PRAGMA user_version"),
      }));
    },
    "state",
  );
});

it("checks only schema facts before the v39 crossing", async () => {
  await withFixture("integrity-scope.sqlite", async ({ database }) => {
    const observer = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
    try {
      for (const check of agentDatabaseIntegrityBeforeMutationSteps(
        database,
        "main",
        database.location()!,
      )) {
        runSqliteIntegrityCheckSync(check);
      }
      expect(
        observer.queries.filter((sql) =>
          /^PRAGMA (?:quick_check|integrity_check|foreign_key_check)/u.test(sql),
        ),
      ).toEqual(["PRAGMA quick_check('schema_meta');"]);
      expect(
        resolveSchemaMigrationIntegrityCheck(
          {
            kind: "agent",
            foundVersion: predecessor,
            supportedVersion: target,
          },
          "full",
        ),
      ).toEqual({ check: "full" });
    } finally {
      observer.restore();
    }
  });
});
