import fs from "node:fs";
import { constants, DatabaseSync, type SQLInputValue } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { deriveContextEngineTurnOutboxState } from "../agents/harness/context-engine-turn-outbox-state.js";
import { deriveSessionPredicateColumns } from "../config/sessions/session-predicate-columns.js";
import { deriveTranscriptPredicateFields } from "../config/sessions/transcript-predicate-fields.js";
import { captureSqliteSchemaFacts } from "../infra/sqlite-schema-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { hasPendingAgentStartupColumns } from "./openclaw-agent-db-additive-columns.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
import { removeCanonicalValidationFromHistoricalAgentFixture } from "./openclaw-agent-db.test-support.js";
import { migrateAgentJsonPredicatesInTransaction } from "./openclaw-agent-json-predicate-schema.js";
import {
  OPENCLAW_AGENT_SCHEMA_V21_SQL,
  restoreEmptyV21StorageForHistoricalFixture,
} from "./openclaw-agent-schema-v21.test-support.js";
import { OPENCLAW_AGENT_SCHEMA_V25_SQL } from "./openclaw-agent-schema-v25.test-support.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import {
  assertOpenClawMigrationWitnessPreserved,
  captureOpenClawMigrationWitness,
} from "./openclaw-migration-witness.js";
import { assertSqliteMigrationScopePreserved } from "./sqlite-migration-scope.test-support.js";

function readRow(database: DatabaseSync, sql: string, ...params: SQLInputValue[]) {
  return database.prepare(sql).get(...params);
}
function readRows(database: DatabaseSync, sql: string) {
  return database.prepare(sql).all();
}
function witness(database: DatabaseSync) {
  return captureOpenClawMigrationWitness(database, { role: "agent", agentId: "main" });
}
function expectVersion(database: DatabaseSync, version = OPENCLAW_AGENT_SCHEMA_VERSION) {
  expect(readRow(database, "PRAGMA user_version")?.user_version).toBe(version);
  expect(readRow(database, "SELECT schema_version FROM schema_meta")?.schema_version).toBe(version);
}
function admit(database: DatabaseSync, path: string, env: NodeJS.ProcessEnv, register?: boolean) {
  return ensureOpenClawAgentDatabaseSchema(database, { agentId: "main", path, env, register });
}
function migrateLegacyStore(database: DatabaseSync, pathname: string, env: NodeJS.ProcessEnv) {
  return withAgentDatabaseMaintenanceLease({ env }, async () =>
    admit(database, pathname, env, false),
  );
}
function seedVersion(database: DatabaseSync, version: number) {
  database.exec(`PRAGMA user_version = ${version};
    INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
    VALUES ('primary', 'agent', ${version}, 'main', 1, 1);`);
}
function seedSchema(database: DatabaseSync) {
  database.exec(OPENCLAW_AGENT_SCHEMA_V25_SQL);
  seedVersion(database, 25);
  database.exec(`INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
    VALUES ('agent:main:main', 'history', '{"sessionId":"history","updatedAt":1}', 1);
    INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
    VALUES ('history', 'agent:main:main', 1, 1);
  `);
}

describe("agent JSON predicate migration", () => {
  it("matches shared writer derivations while preserving raw and compressed payloads", () => {
    using database = new DatabaseSync(":memory:");
    seedSchema(database);
    const sessionEntries = [
      "{}",
      '{"sessionStartedAt":null}',
      '{"sessionStartedAt":1.9}',
      '{"sessionStartedAt":-1.9}',
      '{"sessionStartedAt":true}',
      '{"sessionStartedAt":false}',
      '{"sessionStartedAt":"  -12.9e5"}',
      '{"sessionStartedAt":"not a timestamp"}',
      '{"sessionStartedAt":{}}',
      '{"sessionStartedAt":[]}',
      '{"sessionStartedAt":9223372036854775808}',
      '{"sessionStartedAt":-9223372036854775809}',
      '{"sessionStartedAt":9007199254740993}',
      '{"sessionStartedAt":1e999}',
      '{"sessionStartedAt":12,"sessionStartedAt":34}',
      '{"sessionStartedAt\\u0000suffix":12,"sessionStartedAt":34}',
      '{"previousSessionId\\u0000suffix":null}',
      '{"previousSessionId":null}',
      '{"usageFamilySessionIds":[]}',
      '{"compactionCheckpoints":false}',
      "{}\u0000ignored",
      "{",
      `{"sessionStartedAt":1,"nested":${"[".repeat(1001)}0${"]".repeat(1001)}}`,
    ];
    const insertNode = database.prepare(`INSERT INTO session_nodes
      (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, 1)`);
    for (const [index, entry] of sessionEntries.entries()) {
      insertNode.run(`agent:main:case-${index}`, `case-${index}`, entry);
    }
    const events = [
      "{}",
      '{"type":"message","message":{"role":"assistant"}}',
      '{"type":"custom_message","customType":"openclaw.runtime-context","display":true}',
      '{"type":"custom","customType":"openclaw.cache-ttl","display":1}',
      '{"type":"message","type":"reset","message":{"role":"user","role":"system"}}',
      '{"t\\u0079pe":"message","type":"reset","message":{"role":"user","r\\u006fle":"system"}}',
      '{"type\\u0000suffix":"message","type":"reset","message\\u0000suffix":{"role\\u0000suffix":"user","role":"assistant"}}',
      '{"customType\\u0000suffix":"openclaw.cache-ttl","customType":"openclaw.runtime-context","display\\u0000suffix":true,"display":false}',
      '{"customType":"openclaw.cache-ttl","customType":"openclaw.runtime-context","display":false}',
      '{"type":"unknown","customType":12,"message":{"role":"unknown"}}',
      '{"type":"message\\u0000","message":{"role":"assistant\\ud800"}}',
      "[]",
      "null",
      "{}\u0000ignored",
      "{",
      `{"type":"message","nested":${"[".repeat(999)}0${"]".repeat(999)}}`,
      `{"type":"message","nested":${"[".repeat(1000)}0${"]".repeat(1000)}}`,
      `{"type":"message","nested":${"[".repeat(1001)}0${"]".repeat(1001)}}`,
    ];
    const insertEvent = database.prepare(`INSERT INTO transcript_events
      (session_id, seq, event_json, created_at) VALUES ('history', ?, ?, 1)`);
    for (const [index, event] of events.entries()) {
      insertEvent.run(index + 1, event);
    }
    const compressedEvent = '{"type":"message","message":{"role":"user"}}';
    const compressedBytes = zstdCompressSync(Buffer.from(compressedEvent));
    const navigation = JSON.stringify({
      version: 1,
      report: { kind: "canonical" },
      navigation: JSON.parse(compressedEvent),
      reset: {},
      model: {},
      modelBytes: 0,
      modelWithoutCheckpointBytes: 0,
      withoutCustomDataBytes: 0,
    });
    database
      .prepare(`INSERT INTO transcript_events
      (session_id, seq, event_json, event_zstd, event_utf8_bytes, navigation_json, created_at)
      VALUES ('history', ?, NULL, ?, ?, ?, 1)`)
      .run(events.length + 1, compressedBytes, Buffer.byteLength(compressedEvent), navigation);
    const payloads = [{}, { state: "pending" }, { state: "ready" }, { state: null }, { state: 1 }];
    for (const [index, payload] of payloads.entries()) {
      database
        .prepare(`INSERT INTO context_engine_turn_outbox
        (advancement_key, engine_id, session_id, payload_json, created_at) VALUES (?, 'engine', 'history', ?, 1)`)
        .run(String(index), JSON.stringify(payload));
    }
    database.exec("BEGIN IMMEDIATE");
    migrateAgentJsonPredicatesInTransaction(database);
    database.exec("COMMIT");
    for (const [index, entry] of sessionEntries.entries()) {
      const expected = deriveSessionPredicateColumns(entry);
      expect(
        readRow(
          database,
          `SELECT entry_json, CAST(session_started_at AS TEXT) AS session_started_at,
        has_optional_references FROM session_nodes WHERE session_key = ?`,
          `agent:main:case-${index}`,
        ),
      ).toEqual({
        entry_json: entry,
        session_started_at: expected.session_started_at?.toString() ?? null,
        has_optional_references: expected.has_optional_references,
      });
    }
    const readEvent =
      database.prepare(`SELECT navigation_type, navigation_custom_type, navigation_display,
      message_role, navigation_last_type, navigation_last_custom_type, navigation_valid
      FROM transcript_events WHERE session_id = 'history' AND seq = ?`);
    for (const [index, event] of [...events, compressedEvent].entries()) {
      expect(readEvent.get(index + 1), event).toEqual(deriveTranscriptPredicateFields(event));
    }
    expect(
      readRow(
        database,
        `SELECT event_zstd, navigation_json FROM transcript_events
      WHERE session_id = 'history' AND seq = ?`,
        events.length + 1,
      ),
    ).toEqual({ event_zstd: new Uint8Array(compressedBytes), navigation_json: navigation });
    expect(
      readRows(
        database,
        "SELECT event_json FROM transcript_events WHERE event_json IS NOT NULL ORDER BY seq",
      ),
    ).toEqual(events.map((event_json) => ({ event_json })));
    for (const [index, payload] of payloads.entries()) {
      expect(
        readRow(
          database,
          "SELECT payload_json, payload_state FROM context_engine_turn_outbox WHERE advancement_key = ?",
          String(index),
        ),
      ).toEqual({
        payload_json: JSON.stringify(payload),
        payload_state: deriveContextEngineTurnOutboxState(payload),
      });
    }
  });

  it.each(["commit", "rollback", "without-outbox", "missing-additive-indexes"] as const)(
    "publishes both version markers only with the complete migration (%s)",
    async (outcome) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const pathname = state.path("predicates-v25.sqlite");
        using database = new DatabaseSync(pathname);
        seedSchema(database);
        if (outcome === "without-outbox") {
          database.exec("DROP TABLE context_engine_turn_outbox");
        }
        if (outcome === "missing-additive-indexes") {
          database.exec(`
            DROP INDEX idx_agent_transcript_context_pending;
            DROP INDEX idx_agent_session_nodes_label;
            DROP INDEX idx_agent_session_nodes_entry_not_valid;
          `);
        }
        database.exec(`INSERT INTO transcript_events (session_id, seq, event_json, created_at)
          VALUES ('history', 1, '{"type":"message","message":{"role":"user"}}', 1)`);
        database.exec("ANALYZE");
        const original = witness(database);
        if (outcome === "rollback") {
          database.setAuthorizer((action, name, value) =>
            action === constants.SQLITE_PRAGMA &&
            name === "user_version" &&
            value === String(OPENCLAW_AGENT_SCHEMA_VERSION)
              ? constants.SQLITE_DENY
              : constants.SQLITE_OK,
          );
        }
        await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
          const migrate = () => admit(database, pathname, state.env);
          if (outcome === "rollback") {
            expect(migrate).toThrow(/authoriz/u);
          } else {
            await assertSqliteMigrationScopePreserved(
              database,
              [
                "schema_meta",
                "session_nodes",
                "session_reactions",
                "session_windows",
                "transcript_events",
                "context_engine_turn_outbox",
                "transcript_event_identities",
                "memory_entry_origins",
                "sqlite_stat1",
                "sqlite_stat4",
              ],
              migrate,
            );
          }
        });
        database.setAuthorizer(null);
        const expectedVersion = outcome === "rollback" ? 25 : OPENCLAW_AGENT_SCHEMA_VERSION;
        expectVersion(database, expectedVersion);
        expect(assertOpenClawMigrationWitnessPreserved(original, witness(database))).toEqual({
          warnings: [],
        });
        const columns = readRows(database, "PRAGMA table_info(transcript_events)").map(
          (row) => row.name,
        );
        expect(columns.includes("navigation_type")).toBe(outcome !== "rollback");
        expect(hasPendingAgentStartupColumns(captureSqliteSchemaFacts(database).tableSql)).toBe(
          outcome === "rollback",
        );
        if (outcome === "without-outbox") {
          expect(
            readRow(
              database,
              "SELECT name FROM sqlite_schema WHERE name = 'context_engine_turn_outbox'",
            ),
          ).toBeUndefined();
        }
        if (outcome === "missing-additive-indexes") {
          expect(
            readRows(
              database,
              `SELECT name FROM sqlite_schema WHERE name IN (
              'idx_agent_transcript_context_pending', 'idx_agent_session_nodes_label',
              'idx_agent_session_nodes_entry_not_valid'
            )`,
            ),
          ).toEqual([]);
        }
      });
    },
  );
});

describe("agent outbox sequence migration", () => {
  it.each(["frozen", "restored"] as const)(
    "preserves a v17 outbox through schema admission from %s storage",
    async (source) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const pathname = state.path("outbox-v17.sqlite");
        using database = new DatabaseSync(pathname);
        database.exec(
          source === "frozen" ? OPENCLAW_AGENT_SCHEMA_V21_SQL : OPENCLAW_AGENT_SCHEMA_SQL,
        );
        if (source === "restored") {
          restoreEmptyV21StorageForHistoricalFixture(database);
        }
        removeCanonicalValidationFromHistoricalAgentFixture(database);
        database.exec("DROP TABLE session_participants");
        seedVersion(database, 17);
        const rows = [
          { enqueue_sequence: -7, advancement_key: "z-first", payload_json: '{"state":"ready"}' },
          { enqueue_sequence: 40, advancement_key: "a-last", payload_json: '{"state":"blocked"}' },
        ];
        const insert = database.prepare(`INSERT INTO context_engine_turn_outbox
          (rowid, advancement_key, engine_id, session_id, payload_json, attempt_count, created_at)
          VALUES (?, ?, 'test', 'session', ?, 3, 1)`);
        for (const row of rows) {
          insert.run(row.enqueue_sequence, row.advancement_key, row.payload_json);
        }
        const indexes = readRows(
          database,
          "SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'context_engine_turn_outbox' AND sql IS NOT NULL ORDER BY name",
        );
        await migrateLegacyStore(database, pathname, state.env);
        expectVersion(database);
        expect(readRows(database, "PRAGMA table_info(context_engine_turn_outbox)")).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "enqueue_sequence", type: "INTEGER", pk: 1 }),
            expect.objectContaining({ name: "advancement_key", type: "TEXT", notnull: 1, pk: 0 }),
          ]),
        );
        expect(
          readRows(
            database,
            "SELECT enqueue_sequence, advancement_key, payload_json FROM context_engine_turn_outbox ORDER BY enqueue_sequence",
          ),
        ).toEqual(rows);
        expect(
          readRows(
            database,
            "SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'context_engine_turn_outbox' AND sql IS NOT NULL ORDER BY name",
          ),
        ).toEqual(indexes);
        expect(() => restoreEmptyV21StorageForHistoricalFixture(database)).toThrow(
          "Historical fixture must not discard context_engine_turn_outbox data",
        );
        expect(() => insert.run(100, "z-first", "{}")).toThrow(/UNIQUE/);
        expect(readRow(database, "PRAGMA integrity_check")?.integrity_check).toBe("ok");
        expect(readRows(database, "PRAGMA foreign_key_check")).toEqual([]);
      });
    },
  );

  it("preserves the previous rowids, payloads and FIFO across migration, vacuum and reopen", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = state.path("outbox-v26.sqlite");
      {
        using database = new DatabaseSync(pathname);
        database.exec(
          fs.readFileSync(
            new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v26.sql", import.meta.url),
            "utf8",
          ),
        );
        seedVersion(database, 26);
        const insert = database.prepare(`INSERT INTO context_engine_turn_outbox
        (rowid, advancement_key, engine_id, session_id, payload_json, payload_state, attempt_count, last_attempt_at, last_error, created_at)
        VALUES (?, ?, 'test', 'session', ?, ?, 3, 7, 'retry', ?)`);
        insert.run(7, "z-first", '{"state":"ready"}', "ready", 90);
        insert.run(40, "m-blocked", '{"state":"blocked"}', "blocked", 1);
        insert.run(91, "a-last", '{"state":"accepted"}', "accepted", 20);
        const originalRows = readRows(
          database,
          "SELECT rowid AS enqueue_sequence, * FROM context_engine_turn_outbox ORDER BY rowid",
        );
        const original = witness(database);
        await migrateLegacyStore(database, pathname, state.env);
        expectVersion(database);
        expect(assertOpenClawMigrationWitnessPreserved(original, witness(database))).toEqual({
          warnings: [],
        });
        database.exec("VACUUM");
        expect(
          readRows(database, "SELECT * FROM context_engine_turn_outbox ORDER BY enqueue_sequence"),
        ).toEqual(originalRows);
      }
      using reopened = new DatabaseSync(pathname);
      admit(reopened, pathname, state.env, false);
      reopened
        .prepare(`INSERT INTO context_engine_turn_outbox
        (advancement_key, engine_id, session_id, payload_json, created_at)
        VALUES ('new', 'test', 'session', '{}', 0)`)
        .run();
      expect(
        reopened
          .prepare(
            "SELECT enqueue_sequence, advancement_key FROM context_engine_turn_outbox ORDER BY enqueue_sequence",
          )
          .all(),
      ).toEqual([
        { enqueue_sequence: 7, advancement_key: "z-first" },
        { enqueue_sequence: 40, advancement_key: "m-blocked" },
        { enqueue_sequence: 91, advancement_key: "a-last" },
        { enqueue_sequence: 92, advancement_key: "new" },
      ]);
    });
  });
});
