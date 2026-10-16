import "../../test-utils/prepare-compiled-subprocesses.js";
import "./backup-worker.test-support.js";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { zstdCompressSync } from "node:zlib";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memoryTextSearchSchema } from "../../../packages/memory-host-sdk/src/host/memory-search-schema.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveSessionColdArchivePath } from "../../config/sessions/session-cold-storage-codec.js";
import { prepareTranscriptPayload } from "../../config/sessions/transcript-payload.js";
import {
  capturePostgresBackup,
  preparePostgresRestore,
  readBackupEngine,
} from "../../snapshot/database-backup.js";
import { createLocalSnapshotProvider } from "../../snapshot/local-repository.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { openAgentEngineStore } from "../../state/openclaw-agent-db-engine.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { admitSqliteSchema } from "../sqlite-schema-facts.js";
import { createUpdateDatabaseBackup } from "../update-database-backup.js";
import { admitStoreSearch } from "./adapters.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { agentPortProvider } from "./agent-port.js";
import { withDatabaseEngineSelection } from "./context.js";
import { materializeDatabasePort } from "./port.worker.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";
import { statePortProvider } from "./state-port.js";

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterAll);

describe.skipIf(!connection)("agent database port", () => {
  const client = new Client({ connectionString: connection });
  const namespaces = new Set<string>();
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
    await expect(
      materializeDatabasePort({
        source: { engine: "sqlite", db: source },
        destination: { engine: "postgres", db: client, namespace },
        descriptor,
        storeId: randomUUID(),
        assertCurrent() {},
      }),
    ).rejects.toThrow(/duplicate-key voice JSON; cache key SHA-256 [a-f0-9]{64}/);
    expect(
      (await client.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [namespace])).rows,
    ).toEqual([]);
  });

  it("round-trips compressed transcripts, FIFO work, cold archives and matched backups", async () => {
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
      INSERT INTO memory_entry_origins VALUES ('retained-memory', 'main', 'session', 'agent:main:main', 'owner', 1);
      INSERT INTO memory_session_tombstones VALUES ('forgotten-session', 'main', 'deleted', 1);
      INSERT INTO cache_entries VALUES ('retained', 'binary', NULL, X'00ff80', NULL, 1);`);
    admitSqliteSchema(source);
    const event = JSON.stringify({
      type: "message",
      id: "message",
      parentId: null,
      timestamp: "2026-10-16T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "café sentinel ".repeat(200) }] },
    });
    const payload = prepareTranscriptPayload(source, event);
    expect(payload.event_json).toBeNull();
    expect(payload.event_zstd).toBeInstanceOf(Uint8Array);
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
    const archivedEvent = JSON.stringify({
      type: "message",
      id: "archived",
      message: { role: "user", content: "archived transcript" },
    });
    const cold = zstdCompressSync(
      Buffer.from(
        [
          JSON.stringify({
            kind: "header",
            version: 1,
            sessionId: "session",
            generation: "old-generation",
          }),
          JSON.stringify({
            kind: "event",
            row: { seq: 0, event_json: archivedEvent, created_at: 0 },
          }),
          "",
        ].join("\n"),
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
    const copied = await materializeDatabasePort({
      source: { engine: "sqlite", db: source },
      destination: { engine: "postgres", db: client, namespace },
      descriptor,
      storeId,
      assertCurrent() {},
    });
    expect(
      (await client.query(`SELECT event_json, event_zstd FROM "${namespace}".transcript_events`))
        .rows,
    ).toEqual([{ event_json: event, event_zstd: null }]);
    expect(
      (
        await client.query(
          `SELECT advancement_key FROM "${namespace}".context_engine_turn_outbox ORDER BY enqueue_sequence`,
        )
      ).rows,
    ).toEqual([{ advancement_key: "first" }, { advancement_key: "second" }]);
    expect(
      (
        await client.query(`SELECT message_id FROM "${namespace}".session_transcript_fts
      WHERE openclaw_search @@ plainto_tsquery('"${namespace}".openclaw_simple_unaccent', 'cafe sentinel')`)
      ).rows,
    ).toEqual([{ message_id: "message" }]);
    expect(
      (
        await client.query(
          `SELECT event_id, message_idempotency_key FROM "${namespace}".transcript_event_identities`,
        )
      ).rows,
    ).toEqual([{ event_id: "message", message_idempotency_key: "idempotent" }]);
    expect(
      (
        await client.query(
          `SELECT storage, archive_blob FROM "${namespace}".session_transcript_cold_archives`,
        )
      ).rows,
    ).toEqual([{ storage: "file", archive_blob: null }]);
    expect(
      (
        await client.query(`INSERT INTO "${namespace}".context_engine_turn_outbox
      (advancement_key, engine_id, session_id, payload_json, created_at)
      VALUES ('retired', 'engine', 'session', '{}', 0) RETURNING enqueue_sequence`)
      ).rows,
    ).toEqual([{ enqueue_sequence: "10" }]);
    await client.query(
      `DELETE FROM "${namespace}".context_engine_turn_outbox WHERE advancement_key = 'retired'`,
    );
    {
      using anchor = openNodeSqliteDatabase(anchorPath);
      anchor.exec(
        "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)",
      );
      anchor
        .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
        .run(storeId, namespace);
    }
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
            db.runTransaction(() => {
              db.prepare(`INSERT INTO memory_index_chunks
            (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
            VALUES ('derived-chunk', 'memory/example.md', 'memory', 1, 1, 'hash', 'none', 'derived search sentinel', ?, 1)`).run(
                Buffer.alloc(0),
              );
            });
            expect(
              db
                .prepare(`SELECT id FROM memory_index_chunks
          WHERE openclaw_search @@ plainto_tsquery('"${namespace}".openclaw_simple_unaccent', 'sentinel')`)
                .all(),
            ).toEqual([{ id: "derived-chunk" }]);
          } finally {
            db.close();
          }
        }),
    );
    {
      using roundtrip = openNodeSqliteDatabase(path.join(directory, "roundtrip.sqlite"));
      expect(
        await materializeDatabasePort({
          source: { engine: "postgres", db: client, namespace },
          destination: { engine: "sqlite", db: roundtrip },
          descriptor,
          storeId,
          assertCurrent() {},
        }),
      ).toEqual(copied);
      expect(
        roundtrip.prepare("SELECT event_json, event_zstd FROM transcript_events").get(),
      ).toEqual({ event_json: event, event_zstd: null });
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
          .prepare(
            "SELECT message_id FROM session_transcript_fts WHERE session_transcript_fts MATCH 'sentinel'",
          )
          .all(),
      ).toEqual([{ message_id: "message" }]);
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
        await materializeDatabasePort({
          source: { engine: "sqlite", db: registry },
          destination: { engine: "postgres", db: client, namespace: stateNamespace },
          descriptor: stateDescriptor,
          storeId: stateStoreId,
          assertCurrent() {},
        });
        using anchor = openNodeSqliteDatabase(registryPath);
        anchor.exec(
          "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)",
        );
        anchor
          .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
          .run(stateStoreId, stateNamespace);
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
        (
          await client.query(
            `SELECT storage, archive_blob FROM "${restored.namespace}".session_transcript_cold_archives`,
          )
        ).rows,
      ).toEqual([
        {
          storage: profile === "exact" ? "file" : "sqlite",
          archive_blob: profile === "exact" ? null : cold,
        },
      ]);
      expect(
        (
          await client.query(
            `SELECT blob FROM "${restored.namespace}".cache_entries WHERE scope = 'retained'`,
          )
        ).rows,
      ).toEqual([{ blob: Buffer.from([0, 255, 128]) }]);
      expect(
        (
          await client.query(
            `SELECT entry_key, origin_class FROM "${restored.namespace}".memory_entry_origins`,
          )
        ).rows,
      ).toEqual([{ entry_key: "retained-memory", origin_class: "owner" }]);
      expect(
        (
          await client.query(
            `SELECT session_id FROM "${restored.namespace}".memory_session_tombstones`,
          )
        ).rows,
      ).toEqual([{ session_id: "forgotten-session" }]);
      expect(
        (
          await client.query(
            `SELECT count(*) AS count FROM "${restored.namespace}".memory_index_chunks`,
          )
        ).rows,
      ).toEqual([{ count: "0" }]);
      expect(
        (
          await client.query(`SELECT message_id FROM "${restored.namespace}".session_transcript_fts
        WHERE openclaw_search @@ plainto_tsquery('"${restored.namespace}".openclaw_simple_unaccent', 'sentinel')`)
        ).rows,
      ).toEqual([{ message_id: "message" }]);
      expect(
        (
          await client.query(`INSERT INTO "${restored.namespace}".context_engine_turn_outbox
        (advancement_key, engine_id, session_id, payload_json, created_at)
        VALUES ('next', 'engine', 'session', '{}', 0) RETURNING enqueue_sequence`)
        ).rows,
      ).toEqual([{ enqueue_sequence: "11" }]);
      expect(fs.readFileSync(anchorPath)).toEqual(anchorBytes);
    }
    const extensionMetadata = (
      await client.query<{ search_extensions: string }>(
        `SELECT search_extensions FROM "${namespace}".openclaw_schema_meta WHERE store = 'agent'`,
      )
    ).rows[0]!.search_extensions;
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
        await expect(
          materializeDatabasePort({
            source: { engine: "postgres", db: client, namespace },
            destination: { engine: "sqlite", db: refused },
            descriptor,
            storeId,
            assertCurrent() {},
          }),
        ).rejects.toThrow(/Unknown or changed agent search extension/);
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
      await expect(
        materializeDatabasePort({
          source: { engine: "postgres", db: client, namespace },
          destination: { engine: "sqlite", db: refused },
          descriptor,
          storeId,
          assertCurrent() {},
        }),
      ).rejects.toThrow(/PostgreSQL catalog differs/);
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
