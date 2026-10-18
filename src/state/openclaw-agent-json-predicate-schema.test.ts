import { constants, DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { deriveContextEngineTurnOutboxState } from "../agents/harness/context-engine-turn-outbox-state.js";
import { deriveSessionPredicateColumns } from "../config/sessions/session-predicate-columns.js";
import { deriveTranscriptPredicateFields } from "../config/sessions/transcript-predicate-fields.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
import { migrateAgentJsonPredicatesInTransaction } from "./openclaw-agent-json-predicate-schema.js";
import { OPENCLAW_AGENT_SCHEMA_V25_SQL } from "./openclaw-agent-schema-v25.test-support.js";
import {
  assertOpenClawMigrationWitnessPreserved,
  captureOpenClawMigrationWitness,
} from "./openclaw-migration-witness.js";

function seedSchema(database: DatabaseSync) {
  database.exec(OPENCLAW_AGENT_SCHEMA_V25_SQL);
  database.exec(`PRAGMA user_version = 25;
    INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
    VALUES ('primary', 'agent', 25, 'main', 1, 1);
    INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
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
        database
          .prepare(`SELECT entry_json, CAST(session_started_at AS TEXT) AS session_started_at,
        has_optional_references FROM session_nodes WHERE session_key = ?`)
          .get(`agent:main:case-${index}`),
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
      database
        .prepare(`SELECT event_zstd, navigation_json FROM transcript_events
      WHERE session_id = 'history' AND seq = ?`)
        .get(events.length + 1),
    ).toEqual({ event_zstd: new Uint8Array(compressedBytes), navigation_json: navigation });
    expect(
      database
        .prepare(
          "SELECT event_json FROM transcript_events WHERE event_json IS NOT NULL ORDER BY seq",
        )
        .all(),
    ).toEqual(events.map((event_json) => ({ event_json })));
    for (const [index, payload] of payloads.entries()) {
      expect(
        database
          .prepare(
            "SELECT payload_json, payload_state FROM context_engine_turn_outbox WHERE advancement_key = ?",
          )
          .get(String(index)),
      ).toEqual({
        payload_json: JSON.stringify(payload),
        payload_state: deriveContextEngineTurnOutboxState(payload),
      });
    }
  });

  it.each(["commit", "rollback", "without-outbox"] as const)(
    "publishes both version markers only with the complete migration (%s)",
    async (outcome) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const pathname = state.path("predicates-v25.sqlite");
        using database = new DatabaseSync(pathname);
        seedSchema(database);
        if (outcome === "without-outbox") {
          database.exec("DROP TABLE context_engine_turn_outbox");
        }
        database.exec(`INSERT INTO transcript_events (session_id, seq, event_json, created_at)
          VALUES ('history', 1, '{"type":"message","message":{"role":"user"}}', 1)`);
        const original = captureOpenClawMigrationWitness(database, {
          role: "agent",
          agentId: "main",
        });
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
          const migrate = () =>
            ensureOpenClawAgentDatabaseSchema(database, {
              agentId: "main",
              env: state.env,
              path: pathname,
            });
          if (outcome === "rollback") {
            expect(migrate).toThrow(/authoriz/u);
          } else {
            migrate();
          }
        });
        database.setAuthorizer(null);
        const expectedVersion = outcome === "rollback" ? 25 : OPENCLAW_AGENT_SCHEMA_VERSION;
        expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(expectedVersion);
        expect(
          database.prepare("SELECT schema_version FROM schema_meta").get()?.schema_version,
        ).toBe(expectedVersion);
        expect(
          assertOpenClawMigrationWitnessPreserved(
            original,
            captureOpenClawMigrationWitness(database, { role: "agent", agentId: "main" }),
          ),
        ).toEqual({ warnings: [] });
        const columns = database
          .prepare("PRAGMA table_info(transcript_events)")
          .all()
          .map((row) => row.name);
        expect(columns.includes("navigation_type")).toBe(outcome !== "rollback");
        if (outcome === "without-outbox") {
          expect(
            database
              .prepare("SELECT name FROM sqlite_schema WHERE name = 'context_engine_turn_outbox'")
              .get(),
          ).toBeUndefined();
        }
      });
    },
  );
});
