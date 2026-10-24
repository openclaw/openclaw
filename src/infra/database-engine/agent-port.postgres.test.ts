import "../../test-utils/prepare-compiled-subprocesses.js";
import "./backup-worker.test-support.js";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { zstdCompressSync } from "node:zlib";
import { Client, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  memoryTextSearchSchema,
  memoryStandingIntentSearchSchema,
  memoryVectorSearchSchema,
} from "../../../packages/memory-host-sdk/src/host/memory-search-schema.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { doctorDatabasePort } from "../../commands/doctor-database-port.js";
import { resolveVisibleHistoryEventCount } from "../../config/sessions/session-accessor.sqlite-history-projection.js";
import { readSessionTranscriptHistoryEventPageFromProjection } from "../../config/sessions/session-accessor.sqlite-history-query.js";
import { readCurrentProjectionSnapshot } from "../../config/sessions/session-accessor.sqlite-projection-read.js";
import { resolveSqliteTranscriptReadScope } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { resolveSessionColdArchivePath } from "../../config/sessions/session-cold-storage-codec.js";
import { prepareTranscriptPayload } from "../../config/sessions/transcript-payload.js";
import type { OpenClawConfig } from "../../config/types.js";
import {
  capturePostgresBackup,
  preparePostgresRestore,
  readBackupEngine,
} from "../../snapshot/database-backup.js";
import { createLocalSnapshotProvider } from "../../snapshot/local-repository.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { openAgentEngineStore } from "../../state/openclaw-agent-db-engine.js";
import { getOpenClawAgentMigrationSchema } from "../../state/openclaw-agent-db-schema-helpers.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  prepareTrajectoryPayload,
  readTrajectoryPayload,
  type TrajectoryPayloadRecord,
} from "../../trajectory/runtime-payload.js";
import type { DatabasePortManifest } from "../database-port-recovery.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { admitSqliteSchema } from "../sqlite-schema-facts.js";
import { createUpdateDatabaseBackup } from "../update-database-backup.js";
import { admitStoreSearch } from "./adapters.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { agentPortProvider } from "./agent-port.js";
import { withDatabaseEngineSelection } from "./context.js";
import { writePortAnchor } from "./port-backup.test-support.js";
import { files } from "./port-command.integration.test-support.js";
import type { PortEndpoint } from "./port-descriptor.js";
import { materializeDatabasePort, type PortDescriptor } from "./port.worker.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";
import { statePortProvider } from "./state-port.js";

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterAll);

function port(
  source: PortEndpoint,
  destination: PortEndpoint,
  descriptor: PortDescriptor,
  storeId: string,
) {
  return materializeDatabasePort({ source, destination, descriptor, storeId, assertCurrent() {} });
}
const sqlite = (db: ReturnType<typeof openNodeSqliteDatabase>): PortEndpoint => ({
  engine: "sqlite",
  db,
});
const trajectoryRow = (
  event_json: string,
  event_utf8_bytes: number | null = Buffer.byteLength(event_json),
) => ({ event_json, event_payload: null, event_codec: null, event_utf8_bytes });
const trajectoryValues = (row: TrajectoryPayloadRecord) =>
  [row.event_json, row.event_payload, row.event_codec, row.event_utf8_bytes] as const;
const jsonLines = (...records: unknown[]) =>
  records.map((row) => JSON.stringify(row)).join("\n") + "\n";

describe.skipIf(!connection)("agent database port", () => {
  const client = new Client({ connectionString: connection });
  const namespaces = new Set<string>();
  const pg = (namespace: string): PortEndpoint => ({ engine: "postgres", db: client, namespace });
  const rows = async <T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]) =>
    (await client.query<T>(sql, values)).rows;
  beforeAll(() => client.connect());
  afterAll(async () => {
    for (const namespace of namespaces) {
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    }
    await client.end();
  });

  it("refuses ambiguous voice JSON before publishing a PostgreSQL namespace", async () => {
    const descriptor = await agentPortProvider.loadDescriptor();
    using source = openNodeSqliteDatabase(":memory:");
    source.exec(descriptor.sqlite);
    source
      .prepare(
        "INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES ('talk-client-voice-sessions', ?, ?, 1)",
      )
      .run("private-locator", '{"status":"open","status":"closed"}');
    const namespace = `agent_voice_${randomUUID().replaceAll("-", "")}`;
    await expect(port(sqlite(source), pg(namespace), descriptor, randomUUID())).rejects.toThrow(
      /duplicate-key voice JSON; cache key SHA-256 [a-f0-9]{64}/,
    );
    expect(await rows("SELECT 1 FROM pg_namespace WHERE nspname = $1", [namespace])).toEqual([]);
  });

  it("ports lazy raw and compressed predicates through the verified command into readable PostgreSQL history", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", prefix: "agent-port-lazy-" },
      async (state) => {
        await state.writeConfig({
          database: { engine: "sqlite", postgres: { connection: connection! } },
        });
        const descriptor = await agentPortProvider.loadDescriptor();
        const agentPath = path.join(state.agentDir("main"), "openclaw-agent.sqlite");
        fs.mkdirSync(path.dirname(agentPath), { recursive: true });
        const notice = { type: "custom_message", customType: "synthetic-note", display: true };
        const events = [
          {
            ...notice,
            id: "raw-notice",
            parentId: null,
            content: "raw notice",
            timestamp: "2026-10-17T00:00:00.000Z",
          },
          {
            ...notice,
            id: "compressed-notice",
            parentId: "raw-notice",
            content: "compressed notice ".repeat(200),
            timestamp: "2026-10-17T00:00:01.000Z",
          },
        ];
        {
          using source = openNodeSqliteDatabase(agentPath);
          source.exec(descriptor.sqlite);
          source.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};
            INSERT INTO schema_meta VALUES ('primary', 'agent', ${OPENCLAW_AGENT_SCHEMA_VERSION}, 'main', NULL, 1, 1);
            INSERT INTO session_key_contract (id, main_key, updated_at) VALUES (1, 'main', 0);
            INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
              VALUES ('agent:main:main', 'lazy-session', '{"sessionId":"lazy-session"}', 1);
            INSERT INTO session_windows (session_id, session_key, created_at, updated_at, transcript_updated_at)
              VALUES ('lazy-session', 'agent:main:main', 1, 1, 1);
            INSERT INTO transcript_rewrite_watermarks VALUES ('lazy-session', 'lazy-generation', 1);`);
          admitSqliteSchema(source);
          for (const [seq, event] of events.entries()) {
            const payload = prepareTranscriptPayload(source, JSON.stringify(event));
            expect(payload.event_zstd !== null).toBe(seq === 1);
            source
              .prepare(`INSERT INTO transcript_events
              (session_id, seq, event_json, event_zstd, event_utf8_bytes, navigation_json, created_at)
              VALUES ('lazy-session', ?, ?, ?, ?, ?, 1)`)
              .run(
                seq,
                payload.event_json,
                payload.event_zstd,
                payload.event_utf8_bytes,
                payload.navigation_json,
              );
            source
              .prepare(`INSERT INTO transcript_event_identities
              (session_id, event_id, seq, event_type, created_at)
              VALUES ('lazy-session', ?, ?, 'custom_message', 1)`)
              .run(event.id, seq);
          }
          expect(
            source
              .prepare(
                `SELECT navigation_type, navigation_display FROM transcript_events ORDER BY seq`,
              )
              .all(),
          ).toEqual([
            { navigation_type: null, navigation_display: 0 },
            { navigation_type: null, navigation_display: 0 },
          ]);
        }
        try {
          const result = await doctorDatabasePort({ family: "agent", to: "postgres" });
          expect(result).toMatchObject({
            phase: "complete",
            engine: "postgres",
            stores: [agentPath],
          });
          if (!("manifest" in result)) {
            throw new Error("Expected a completed, verified database port");
          }
          const manifest = JSON.parse(
            fs.readFileSync(result.manifest, "utf8"),
          ) as DatabasePortManifest;
          expect(manifest).toMatchObject({ state: "complete", outcome: "ported" });
          expect(manifest.targets[0]?.verification).toMatchObject({ ownerAdmitted: true });
          expect(manifest.targets[0]?.verification?.contentHash).toMatch(/^[a-f0-9]{64}$/);
          const config = JSON.parse(fs.readFileSync(state.configPath, "utf8")) as OpenClawConfig;
          withDatabaseEngineSelection(
            {
              effectiveEngines: resolveDatabaseFamilyEngines(config),
              postgres: { connection: connection!, schemaPrefix: "test" },
            },
            () =>
              withEngineStoreAdmission(() => {
                using anchor = openNodeSqliteDatabase(agentPath);
                const db = openAgentEngineStore(anchor, "main", agentPath, true);
                try {
                  expect(isPostgresSqlConnection(db)).toBe(true);
                  const read = readCurrentProjectionSnapshot(
                    { db, agentId: "main", path: agentPath },
                    resolveSqliteTranscriptReadScope({
                      agentId: "main",
                      env: state.env,
                      sessionId: "lazy-session",
                      sessionKey: "agent:main:main",
                      storePath: agentPath,
                    }),
                    (projection) => ({
                      count: resolveVisibleHistoryEventCount(projection),
                      page: readSessionTranscriptHistoryEventPageFromProjection(projection, {
                        offset: 0,
                        maxMessages: 10,
                      }),
                    }),
                  );
                  expect(read.kind).toBe("value");
                  if (read.kind !== "value") {
                    throw new Error("Expected the port to publish readable history");
                  }
                  expect(read.value).toMatchObject({ count: 2, page: { totalMessages: 2 } });
                  expect(read.value.page.events.map(({ event }) => event)).toEqual(events);
                } finally {
                  db.close();
                }
              }),
          );
        } finally {
          const directory = state.statePath("recovery", "database-port");
          if (fs.existsSync(directory)) {
            const ownedNamespaces = new Set<string>();
            for (const file of await files(directory)) {
              if (path.basename(file) !== "manifest.json") {
                continue;
              }
              const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as DatabasePortManifest;
              for (const target of manifest.targets) {
                if (target.intended.engine === "postgres") {
                  ownedNamespaces.add(target.intended.namespace);
                }
              }
            }
            for (const namespace of ownedNamespaces) {
              await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
            }
          }
        }
      },
    );
  }, 120_000);

  it.each([27, 28, 29, 30, 32])(
    "round-trips version %s with its historical trajectory layout and revision triggers",
    async (version) => {
      const descriptor = await agentPortProvider.loadDescriptor(undefined, version);
      using source = openNodeSqliteDatabase(":memory:");
      source.exec(getOpenClawAgentMigrationSchema(version));
      source.exec(`
      INSERT INTO schema_meta VALUES ('primary', 'agent', ${version}, 'main', NULL, 1, 1);
      INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
        VALUES ('agent:main:main', 'session', '{"sessionId":"session"}', 1);
      INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
        VALUES ('session', 'agent:main:main', 1, 1);
    `);
      const event = '{ "type": "legacy", "data": { "text": "café 🦞" } }';
      source
        .prepare(`INSERT INTO trajectory_runtime_events
          (session_id, seq, run_id, event_json, created_at) VALUES ('session', 0, NULL, ?, 1)`)
        .run(event);
      const namespace = `agent_legacy_${randomUUID().replaceAll("-", "")}`;
      const storeId = randomUUID();
      namespaces.add(namespace);
      await port(sqlite(source), pg(namespace), descriptor, storeId);
      const trajectoryColumns =
        version < 30
          ? {}
          : {
              event_utf8_bytes: null,
              event_payload: null,
              event_codec: null,
            };
      const expected = {
        session_id: "session",
        run_id: null,
        event_json: event,
        ...trajectoryColumns,
      };
      expect(await rows(`SELECT * FROM "${namespace}".trajectory_runtime_events`)).toEqual([
        { ...expected, seq: "0", created_at: "1" },
      ]);
      expect(
        await rows(
          `SELECT p.proisstrict, p.proconfig FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = $1 AND p.proname = 'openclaw_transcript_navigation_check'`,
          [namespace],
        ),
      ).toEqual([
        version < 29
          ? { proisstrict: false, proconfig: null }
          : { proisstrict: true, proconfig: ["search_path=pg_catalog"] },
      ]);
      await client.query(`INSERT INTO "${namespace}".memory_index_sources (path, source, hash, mtime, size)
          VALUES ('retained.md', 'memory', 'hash', 1, 1);`);
      expect(await rows(`SELECT revision FROM "${namespace}".memory_index_state`)).toEqual([
        { revision: version < 31 ? "1" : "0" },
      ]);
      using restored = openNodeSqliteDatabase(":memory:");
      await port(pg(namespace), sqlite(restored), descriptor, storeId);
      expect(restored.prepare("SELECT * FROM trajectory_runtime_events").all()).toEqual([
        { ...expected, seq: 0, created_at: 1 },
      ]);
      restored.exec(`INSERT INTO memory_index_sources (path, source, hash, mtime, size)
          VALUES ('retained.md', 'memory', 'hash', 1, 1);`);
      expect(restored.prepare("SELECT revision FROM memory_index_state").get()).toEqual({
        revision: version < 31 ? 1 : 0,
      });
    },
  );

  it("preserves native PostgreSQL trajectory text and storage columns through SQLite", async () => {
    const descriptor = await agentPortProvider.loadDescriptor();
    using seed = openNodeSqliteDatabase(":memory:");
    seed.exec(descriptor.sqlite);
    seed.exec(`
      INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
        VALUES ('agent:main:main', 'session', '{"sessionId":"session"}', 1);
      INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
        VALUES ('session', 'agent:main:main', 1, 1);
    `);
    const namespace = `agent_native_${randomUUID().replaceAll("-", "")}`;
    const restoredNamespace = `agent_native_${randomUUID().replaceAll("-", "")}`;
    const storeId = randomUUID();
    namespaces.add(namespace);
    namespaces.add(restoredNamespace);
    await port(sqlite(seed), pg(namespace), descriptor, storeId);
    const events = [
      `{ "type": "context.compiled", "data": { "text": "${"café 🦞 ".repeat(500)}" } }`,
      '{ "type": "small", "data": "7aQ9vE2xR8kM4pL6" }',
    ];
    const expected = events.map((event) => trajectoryRow(event));
    for (const [seq, row] of expected.entries()) {
      await client.query(
        `INSERT INTO "${namespace}".trajectory_runtime_events
          (session_id, seq, event_json, event_payload, event_codec, event_utf8_bytes, created_at)
          VALUES ('session', $1, $2, $3, $4, $5, 1)`,
        [seq, ...trajectoryValues(row)],
      );
    }
    using restored = openNodeSqliteDatabase(":memory:");
    await port(pg(namespace), sqlite(restored), descriptor, storeId);
    expect(
      restored
        .prepare(`SELECT event_json, event_payload, event_codec, event_utf8_bytes
          FROM trajectory_runtime_events ORDER BY seq`)
        .all(),
    ).toEqual(expected);
    await port(sqlite(restored), pg(restoredNamespace), descriptor, storeId);
    const returned = await client.query<TrajectoryPayloadRecord>(
      `SELECT event_json, event_payload, event_codec,
        CAST(event_utf8_bytes AS double precision) AS event_utf8_bytes
        FROM "${restoredNamespace}".trajectory_runtime_events ORDER BY seq`,
    );
    expect(returned.rows).toEqual(expected);
    expect(returned.rows.map(readTrajectoryPayload)).toEqual(events);
  });

  it("round-trips compressed transcripts and trajectories, FIFO work, cold archives and matched backups", async () => {
    const descriptor = await agentPortProvider.loadDescriptor();
    const directory = tempDirs.make("agent-port-");
    const sourcePath = path.join(directory, "openclaw-agent.sqlite");
    const anchorPath = path.join(directory, "anchor.sqlite");
    const namespace = `agent_port_${randomUUID().replaceAll("-", "")}`;
    const storeId = randomUUID();
    namespaces.add(namespace);
    using source = openNodeSqliteDatabase(sourcePath);
    source.exec(descriptor.sqlite);
    source.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};
      INSERT INTO schema_meta VALUES ('primary', 'agent', ${OPENCLAW_AGENT_SCHEMA_VERSION}, 'main', NULL, 1, 1);
      INSERT INTO session_key_contract (id, main_key, updated_at) VALUES (1, 'main', 0);
      INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
        VALUES ('agent:main:main', 'session', '{"sessionId":"session"}', 1);
      INSERT INTO session_windows (session_id, session_key, created_at, updated_at, transcript_updated_at)
        VALUES ('session', 'agent:main:main', 1, 1, 1);
      INSERT INTO transcript_rewrite_watermarks VALUES ('session', 'generation', 1);
      INSERT INTO context_engine_turn_outbox (enqueue_sequence, advancement_key, engine_id, session_id, payload_json, created_at)
        VALUES (7, 'first', 'engine', 'session', '{}', 9), (9, 'second', 'engine', 'session', '{}', 1);
      INSERT INTO standing_intents (id, description, trigger_keywords, creator_sender, status, expires_at, max_fires, fire_count, cooldown_seconds, created_at) VALUES ('retained-intent', 'Remember turquoise', '["turquoise"]', 'synthetic-owner', 'armed', 9999999999999, 3, 0, 1, 1);
      INSERT INTO memory_entry_origins VALUES ('retained-memory', 'main', 'session', 'agent:main:main', 'owner', 1);
      INSERT INTO memory_session_tombstones VALUES ('forgotten-session', 'main', 'deleted', 1);
      INSERT INTO cache_entries VALUES ('retained', 'binary', NULL, X'00ff80', NULL, 1);`);
    const cachedEmbedding = Buffer.from("000000000000f03f0000000000000080", "hex");
    for (const providerKey of ["current-provider-settings", "retained-provider-settings"]) {
      source
        .prepare(`INSERT INTO memory_embedding_cache
        (provider, model, provider_key, hash, embedding, dims, updated_at)
        VALUES ('fixture-provider', 'fixture-model', ?, 'unchanged-chunk', ?, 2, 17)`)
        .run(providerKey, cachedEmbedding);
    }
    admitSqliteSchema(source);
    const event = JSON.stringify({
      type: "message",
      id: "message",
      parentId: null,
      timestamp: "2026-10-16T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "café sentinel ".repeat(200) }] },
    });
    const payload = prepareTranscriptPayload(source, event);
    expect(payload).toMatchObject({ event_json: null, event_zstd: expect.any(Uint8Array) });
    source
      .prepare(`INSERT INTO transcript_events
      (session_id, seq, event_json, event_zstd, event_utf8_bytes, navigation_json, created_at)
      VALUES ('session', 1, ?, ?, ?, ?, 1)`)
      .run(
        payload.event_json,
        payload.event_zstd,
        payload.event_utf8_bytes,
        payload.navigation_json,
      );
    source.exec(`INSERT INTO transcript_event_identities
      (session_id, event_id, seq, event_type, message_idempotency_key, created_at)
      VALUES ('session', 'message', 1, 'message', 'idempotent', 1);`);
    const legacyTrajectory = '{ "type": "legacy", "data": { "value": "retained" } }';
    const compressedTrajectory = `{ "type": "context.compiled", "data": { "text": "${"café 🦞 ".repeat(500)}" } }`;
    const smallTrajectory = '{ "type": "small", "data": "7aQ9vE2xR8kM4pL6" }';
    const trajectoryPayload = prepareTrajectoryPayload(source, compressedTrajectory);
    const smallPayload = prepareTrajectoryPayload(source, smallTrajectory);
    expect(trajectoryPayload).toMatchObject({
      event_payload: expect.any(Uint8Array),
      event_codec: "br",
    });
    expect(smallPayload).toEqual(trajectoryRow(smallTrajectory));
    source
      .prepare(`INSERT INTO trajectory_runtime_events
      (session_id, seq, event_json, event_payload, event_codec, event_utf8_bytes, created_at)
      VALUES ('session', 0, ?, NULL, NULL, NULL, 1), ('session', 1, ?, ?, ?, ?, 1),
        ('session', 2, ?, ?, ?, ?, 1)`)
      .run(
        legacyTrajectory,
        ...trajectoryValues(trajectoryPayload),
        ...trajectoryValues(smallPayload),
      );
    const archivedEvent = JSON.stringify({
      type: "message",
      id: "archived",
      message: { role: "user", content: "archived transcript" },
    });
    const cold = zstdCompressSync(
      Buffer.from(
        jsonLines(
          { kind: "header", version: 1, sessionId: "session", generation: "old-generation" },
          { kind: "event", row: { seq: 0, event_json: archivedEvent, created_at: 0 } },
        ),
      ),
    );
    const coldHash = createHash("sha256").update(cold).digest("hex");
    const coldName = `${coldHash}.jsonl.zst`;
    const coldPath = resolveSessionColdArchivePath(anchorPath, coldName);
    fs.mkdirSync(path.dirname(coldPath), { recursive: true });
    fs.writeFileSync(coldPath, cold);
    source
      .prepare(`INSERT INTO session_transcript_cold_archives
      (session_id, generation, archive_name, archive_sha256, event_count, raw_bytes, archive_bytes, last_seq, archived_at, storage)
      VALUES ('session', 'old-generation', ?, ?, 1, ?, ?, 0, 1, 'file')`)
      .run(coldName, coldHash, Buffer.byteLength(archivedEvent), cold.byteLength);
    const sourceBytes = fs.readFileSync(sourcePath);
    const copied = await port(sqlite(source), pg(namespace), descriptor, storeId);
    expect(
      await rows(`SELECT event_json, event_zstd FROM "${namespace}".transcript_events`),
    ).toEqual([{ event_json: event, event_zstd: null }]);
    const portedTrajectories = await client.query<TrajectoryPayloadRecord>(
      `SELECT event_json, event_payload, event_codec,
        CAST(event_utf8_bytes AS double precision) AS event_utf8_bytes
        FROM "${namespace}".trajectory_runtime_events ORDER BY seq`,
    );
    const expectedTrajectories = [
      trajectoryRow(legacyTrajectory, null),
      trajectoryRow(compressedTrajectory),
      trajectoryRow(smallTrajectory),
    ];
    expect(portedTrajectories.rows).toEqual(expectedTrajectories);
    expect(portedTrajectories.rows.map(readTrajectoryPayload)).toEqual([
      legacyTrajectory,
      compressedTrajectory,
      smallTrajectory,
    ]);
    expect(
      await rows(`SELECT event_utf8_bytes = octet_length(event_json) AS matches_stored_bytes
          FROM "${namespace}".trajectory_runtime_events WHERE session_id = 'session' AND seq = 1`),
    ).toEqual([{ matches_stored_bytes: true }]);
    expect(
      await rows(
        `SELECT advancement_key FROM "${namespace}".context_engine_turn_outbox ORDER BY enqueue_sequence`,
      ),
    ).toEqual([{ advancement_key: "first" }, { advancement_key: "second" }]);
    expect(
      await rows(`SELECT message_id FROM "${namespace}".session_transcript_fts
      WHERE openclaw_search @@ plainto_tsquery('"${namespace}".openclaw_simple_unaccent', 'cafe sentinel')`),
    ).toEqual([{ message_id: "message" }]);
    expect(
      await rows(
        `SELECT event_id, message_idempotency_key FROM "${namespace}".transcript_event_identities`,
      ),
    ).toEqual([{ event_id: "message", message_idempotency_key: "idempotent" }]);
    expect(
      await rows(
        `SELECT storage, archive_blob FROM "${namespace}".session_transcript_cold_archives`,
      ),
    ).toEqual([{ storage: "file", archive_blob: null }]);
    expect(
      await rows(`INSERT INTO "${namespace}".context_engine_turn_outbox
      (advancement_key, engine_id, session_id, payload_json, created_at)
      VALUES ('retired', 'engine', 'session', '{}', 0) RETURNING enqueue_sequence`),
    ).toEqual([{ enqueue_sequence: "10" }]);
    await client.query(
      `DELETE FROM "${namespace}".context_engine_turn_outbox WHERE advancement_key = 'retired'`,
    );
    writePortAnchor(anchorPath, storeId, namespace);
    await descriptor.admit!(anchorPath, { connection: connection!, schemaPrefix: "test" });
    const config = { database: { engine: "postgres" as const, postgres: { connection } } };
    withDatabaseEngineSelection(
      {
        effectiveEngines: resolveDatabaseFamilyEngines(config),
        postgres: { connection: connection!, schemaPrefix: "test" },
      },
      () =>
        withEngineStoreAdmission(() => {
          using anchor = openNodeSqliteDatabase(anchorPath);
          const db = openAgentEngineStore(anchor, "main", anchorPath, true);
          if (!isPostgresSqlConnection(db)) {
            throw new Error("Expected the admitted PostgreSQL agent owner");
          }
          try {
            admitStoreSearch(db, memoryTextSearchSchema("unicode61"), { extension: "memory.text" });
            admitStoreSearch(db, memoryStandingIntentSearchSchema, {
              extension: "memory.standing-intents",
            });
            admitStoreSearch(db, memoryVectorSearchSchema(3), { extension: "memory.vector" });
            const vector = Buffer.alloc(24);
            vector.writeDoubleLE(1, 0);
            vector.writeDoubleLE(-1, 16);
            db.runTransaction(() => {
              db.prepare(`INSERT INTO memory_index_chunks
            (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
            VALUES ('derived-chunk', 'memory/example.md', 'memory', 1, 1, 'hash', 'none', 'derived search sentinel', ?, 1)`).run(
                vector,
              );
            });
            expect(
              db
                .prepare(`SELECT id FROM memory_index_chunks
          WHERE openclaw_search @@ plainto_tsquery('"${namespace}".openclaw_simple_unaccent', 'sentinel')`)
                .all(),
            ).toEqual([{ id: "derived-chunk" }]);
            expect(
              db.prepare("SELECT embedding_bits::text AS bits FROM memory_index_chunks_vec").get(),
            ).toEqual({ bits: "100" });
          } finally {
            db.close();
          }
        }),
    );
    {
      using roundtrip = openNodeSqliteDatabase(path.join(directory, "roundtrip.sqlite"));
      expect(await port(pg(namespace), sqlite(roundtrip), descriptor, storeId)).toEqual(copied);
      expect(
        roundtrip.prepare("SELECT event_json, event_zstd FROM transcript_events").get(),
      ).toEqual({
        event_json: event,
        event_zstd: null,
      });
      expect(
        roundtrip
          .prepare(`SELECT event_json, event_payload, event_codec, event_utf8_bytes
          FROM trajectory_runtime_events ORDER BY seq`)
          .all(),
      ).toEqual(expectedTrajectories);
      expect(
        roundtrip.prepare("SELECT entry_key, origin_class FROM memory_entry_origins").all(),
      ).toEqual([{ entry_key: "retained-memory", origin_class: "owner" }]);
      expect(roundtrip.prepare("SELECT session_id FROM memory_session_tombstones").all()).toEqual([
        { session_id: "forgotten-session" },
      ]);
      expect(roundtrip.prepare("SELECT count(*) AS count FROM memory_index_chunks").get()).toEqual({
        count: 0,
      });
      expect(
        roundtrip
          .prepare(`SELECT provider, model, provider_key, hash, hex(embedding) AS embedding,
          dims, updated_at FROM memory_embedding_cache ORDER BY provider_key`)
          .all(),
      ).toEqual(
        ["current-provider-settings", "retained-provider-settings"].map((provider_key) => ({
          provider: "fixture-provider",
          model: "fixture-model",
          provider_key,
          hash: "unchanged-chunk",
          embedding: "000000000000F03F0000000000000080",
          dims: 2,
          updated_at: 17,
        })),
      );
      expect(
        roundtrip
          .prepare(
            "SELECT message_id FROM session_transcript_fts WHERE session_transcript_fts MATCH 'sentinel'",
          )
          .all(),
      ).toEqual([{ message_id: "message" }]);
      expect(
        roundtrip.prepare("SELECT id FROM standing_intents WHERE id = 'retained-intent'").get(),
      ).toEqual({
        id: "retained-intent",
      });
      expect(
        roundtrip
          .prepare(
            "SELECT rowid FROM standing_intents_fts WHERE standing_intents_fts MATCH 'turquoise'",
          )
          .all(),
      ).toHaveLength(1);
      expect(
        roundtrip
          .prepare(`INSERT INTO context_engine_turn_outbox
        (advancement_key, engine_id, session_id, payload_json, created_at)
        VALUES ('next', 'engine', 'session', '{}', 0) RETURNING enqueue_sequence`)
          .get(),
      ).toEqual({ enqueue_sequence: 10 });
    }
    const anchorBytes = fs.readFileSync(anchorPath);
    for (const registryEngine of ["sqlite", "postgres"]) {
      const stateDir = path.join(directory, `update-state-${registryEngine}`);
      fs.mkdirSync(path.join(stateDir, "state"), { recursive: true });
      const registryPath = path.join(stateDir, "state", "openclaw.sqlite");
      if (registryEngine === "sqlite") {
        using registry = openNodeSqliteDatabase(registryPath);
        registry.exec("PRAGMA user_version=17; CREATE TABLE agent_databases(path TEXT)");
        registry.prepare("INSERT INTO agent_databases VALUES (?)").run(anchorPath);
      } else {
        const stateDescriptor = await statePortProvider.loadDescriptor();
        const stateStoreId = randomUUID();
        const stateNamespace = `agent_registry_${stateStoreId.replaceAll("-", "")}`;
        namespaces.add(stateNamespace);
        using registry = openNodeSqliteDatabase(":memory:");
        registry.exec(stateDescriptor.sqlite);
        for (const fragment of stateDescriptor.fragments ?? []) {
          registry.exec(fragment.sqlite);
        }
        registry.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
          INSERT INTO schema_meta VALUES ('primary', 'global', ${OPENCLAW_STATE_SCHEMA_VERSION}, NULL, NULL, 1, 1);
          INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '${OPENCLAW_STATE_SCHEMA_VERSION}', 1);`);
        registry
          .prepare(
            "INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at) VALUES ('main', ?, ?, 1)",
          )
          .run(anchorPath, OPENCLAW_AGENT_SCHEMA_VERSION);
        await port(sqlite(registry), pg(stateNamespace), stateDescriptor, stateStoreId);
        writePortAnchor(registryPath, stateStoreId, stateNamespace);
      }
      const capture = {
        backupRoot: path.join(directory, `update-backup-${registryEngine}`),
        stateDir,
        config,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        stopped: true,
      };
      if (registryEngine === "sqlite") {
        // R14 refuses a PostgreSQL-configured update backed by a physical SQLite registry.
        await expect(createUpdateDatabaseBackup(capture)).rejects.toThrow(
          /Existing SQLite state data cannot switch engines/,
        );
        continue;
      }
      const update = await createUpdateDatabaseBackup(capture);
      const retained = update.databases.find((entry) => entry.path === anchorPath);
      expect(retained).toMatchObject({ engine: "postgres", storeId, namespace });
      using updateExport = openNodeSqliteDatabase(
        path.join(retained!.exportDirectory!, "database.sqlite"),
        {
          readOnly: true,
        },
      );
      expect(updateExport.prepare("SELECT event_json FROM transcript_events").get()).toEqual({
        event_json: event,
      });
    }
    for (const profile of ["exact", "user-backup"] as const) {
      const backupDirectory = path.join(directory, profile);
      const manifest = await capturePostgresBackup({
        sourcePath: anchorPath,
        directory: backupDirectory,
        profile,
        config,
        assertCurrent() {},
      });
      expect(manifest.source.owner).toBe("agent");
      expect(
        manifest.verification.allocations["context_engine_turn_outbox.enqueue_sequence"],
      ).toEqual({ value: "10", called: true });
      expect(manifest.sanitizedDifferences).toEqual(profile === "exact" ? [] : ["transient-state"]);
      const restoredPath = path.join(directory, `${profile}-restored.sqlite`);
      const restored = await preparePostgresRestore({
        directory: backupDirectory,
        anchorPath: restoredPath,
        profile,
        config,
        assertCurrent() {},
      });
      namespaces.add(restored.namespace);
      expect(readBackupEngine(restoredPath)).toEqual({
        engine: "postgres",
        storeId,
        namespace: restored.namespace,
      });
      expect(restored.sha256).toBe(
        createHash("sha256").update(fs.readFileSync(restoredPath)).digest("hex"),
      );
      expect(
        await rows(
          `SELECT storage, archive_blob FROM "${restored.namespace}".session_transcript_cold_archives`,
        ),
      ).toEqual([
        {
          storage: profile === "exact" ? "file" : "sqlite",
          archive_blob: profile === "exact" ? null : cold,
        },
      ]);
      expect(
        await rows(
          `SELECT blob FROM "${restored.namespace}".cache_entries WHERE scope = 'retained'`,
        ),
      ).toEqual([{ blob: Buffer.from([0, 255, 128]) }]);
      expect(
        await rows(
          `SELECT entry_key, origin_class FROM "${restored.namespace}".memory_entry_origins`,
        ),
      ).toEqual([{ entry_key: "retained-memory", origin_class: "owner" }]);
      expect(
        await rows(`SELECT session_id FROM "${restored.namespace}".memory_session_tombstones`),
      ).toEqual([{ session_id: "forgotten-session" }]);
      expect(
        await rows(`SELECT count(*) AS count FROM "${restored.namespace}".memory_index_chunks`),
      ).toEqual([{ count: "0" }]);
      // Memory indexes are omitted by the port and rebuilt by their current admitted owner.
      expect(
        await rows(
          `SELECT to_regclass('"${restored.namespace}".memory_index_chunks_vec') AS projection`,
        ),
      ).toEqual([{ projection: null }]);
      withDatabaseEngineSelection(
        {
          effectiveEngines: resolveDatabaseFamilyEngines(config),
          postgres: { connection: connection!, schemaPrefix: "test" },
        },
        () =>
          withEngineStoreAdmission(() => {
            using restoredAnchor = openNodeSqliteDatabase(restoredPath);
            const rebuilt = openAgentEngineStore(restoredAnchor, "main", restoredPath, true);
            try {
              if (!isPostgresSqlConnection(rebuilt)) {
                throw new Error("Expected PostgreSQL");
              }
              admitStoreSearch(rebuilt, memoryVectorSearchSchema(3), {
                extension: "memory.vector",
              });
              const bytes = Buffer.alloc(24);
              bytes.writeDoubleLE(1);
              rebuilt.runTransaction(() => {
                rebuilt
                  .prepare(`INSERT INTO memory_index_chunks
              (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
              VALUES ('rebuilt', 'memory/rebuilt.md', 'memory', 1, 1, 'hash', 'fixture', 'rebuilt', ?, 1)`)
                  .run(bytes);
              });
              expect(
                rebuilt
                  .prepare("SELECT embedding_bits::text AS bits FROM memory_index_chunks_vec")
                  .get(),
              ).toEqual({ bits: "100" });
            } finally {
              rebuilt.close();
            }
          }),
      );
      expect(
        await rows(`SELECT message_id FROM "${restored.namespace}".session_transcript_fts
        WHERE openclaw_search @@ plainto_tsquery('"${restored.namespace}".openclaw_simple_unaccent', 'sentinel')`),
      ).toEqual([{ message_id: "message" }]);
      expect(
        await rows(`INSERT INTO "${restored.namespace}".context_engine_turn_outbox
        (advancement_key, engine_id, session_id, payload_json, created_at)
        VALUES ('next', 'engine', 'session', '{}', 0) RETURNING enqueue_sequence`),
      ).toEqual([{ enqueue_sequence: "11" }]);
      expect(fs.readFileSync(anchorPath)).toEqual(anchorBytes);
    }
    await client.query(
      `SELECT setval('"${namespace}".context_engine_turn_outbox_enqueue_sequence_seq', 3, false)`,
    );
    const resetDirectory = path.join(directory, "reset-sequence");
    const reset = await capturePostgresBackup({
      sourcePath: anchorPath,
      directory: resetDirectory,
      profile: "exact",
      config,
      assertCurrent() {},
    });
    expect(reset.verification.allocations["context_engine_turn_outbox.enqueue_sequence"]).toEqual({
      value: "3",
      called: false,
    });
    const resetRestore = await preparePostgresRestore({
      directory: resetDirectory,
      anchorPath: path.join(directory, "reset-restored.sqlite"),
      profile: "exact",
      config,
      assertCurrent() {},
    });
    namespaces.add(resetRestore.namespace);
    expect(
      await rows(
        `SELECT max(enqueue_sequence) AS retained FROM "${resetRestore.namespace}".context_engine_turn_outbox`,
      ),
    ).toEqual([{ retained: "9" }]);
    expect(
      await rows(
        `SELECT nextval('"${resetRestore.namespace}".context_engine_turn_outbox_enqueue_sequence_seq')::text AS next`,
      ),
    ).toEqual([{ next: "3" }]);
    const extensionMetadata = (
      await rows<{ search_extensions: string }>(
        `SELECT search_extensions FROM "${namespace}".openclaw_schema_meta WHERE store = 'agent'`,
      )
    )[0]!.search_extensions;
    for (const extensions of [
      { "unowned.memory": memoryTextSearchSchema("unicode61") },
      { "memory.text": { ...memoryTextSearchSchema("unicode61"), mode: "keyword-only" } },
    ]) {
      await client.query(
        `UPDATE "${namespace}".openclaw_schema_meta SET search_extensions = $1 WHERE store = 'agent'`,
        [JSON.stringify(extensions)],
      );
      try {
        using refused = openNodeSqliteDatabase(":memory:");
        await expect(port(pg(namespace), sqlite(refused), descriptor, storeId)).rejects.toThrow(
          /Unknown or changed agent search extension/,
        );
      } finally {
        await client.query(
          `UPDATE "${namespace}".openclaw_schema_meta SET search_extensions = $1 WHERE store = 'agent'`,
          [extensionMetadata],
        );
      }
    }
    await client.query(`DROP INDEX "${namespace}".memory_index_chunks_search_gin`);
    {
      using refused = openNodeSqliteDatabase(":memory:");
      await expect(port(pg(namespace), sqlite(refused), descriptor, storeId)).rejects.toThrow(
        /PostgreSQL catalog differs/,
      );
    }
    expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes);

    const provider = createLocalSnapshotProvider({
      repositoryPath: path.join(directory, "snapshots"),
    });
    const snapshot = await provider.create({
      path: sourcePath,
      identity: { role: "agent", agentId: "main" },
    });
    const artifactPath = path.join(snapshot.ref.path, "database.sqlite");
    const artifactBytes = fs.readFileSync(artifactPath);
    const restoredSqlite = path.join(directory, "sqlite-restored.sqlite");
    await provider.restoreFresh(snapshot.ref, restoredSqlite);
    expect(fs.readFileSync(restoredSqlite)).toEqual(artifactBytes);
    expect(fs.readFileSync(artifactPath)).toEqual(artifactBytes);
    expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes);
  });
});
