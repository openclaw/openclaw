import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { reconcileSessionTranscriptIndexInTransaction } from "../config/sessions/session-transcript-index.js";
import type { TranscriptTurnBoundary } from "../config/sessions/transcript-entry-anchor.js";
import { createTranscriptEventInserter } from "../config/sessions/transcript-payload.js";
import type { ContextEngine } from "../context-engine/types.js";
import { withEngineStoreAdmission as admit } from "../infra/database-engine/admission-scope.js";
import * as engineSelection from "../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import type { SearchSchema } from "../infra/database-engine/contract.js";
import { openEngineStore } from "../infra/database-engine/open.js";
import { getPostgresPhysicalFacts as postgresFacts } from "../infra/database-engine/physical-facts.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { iterateSqliteQuerySync } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { dropPostgresTestSchemas } from "../infra/postgres-sync/schema-cleanup.test-support.js";
import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import { retireSqliteDatabaseAdmissionForPath as retireAdmission } from "../infra/sqlite-database-admission.js";
import { migrateHistoricalTranscriptDirectives } from "../infra/state-migrations.transcript-directives.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION as schemaVersion } from "./openclaw-agent-db-contract.js";
import { agentEngineSchema } from "./openclaw-agent-db-engine.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import {
  createDatabaseOpener,
  expectAnchorOnly,
  loadOwners,
} from "./openclaw-agent-db.postgres.test-support.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const closeReceipts = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (name: string) => {
      const logger = actual.createSubsystemLogger(name);
      return name === "state/agent-db" ? { ...logger, info: closeReceipts } : logger;
    },
  };
});

const configured: unknown = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const prefix = `agenttest_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
let root: string;
let client: pg.Client;
let owners: Awaited<ReturnType<typeof loadOwners>>;
let openDatabase: ReturnType<typeof createDatabaseOpener>;

const targetFor = (sessionId: string, agentId = "actor", key = sessionId) => ({
  agentId,
  sessionId,
  sessionKey: `agent:${agentId}:${key}`,
  storePath: path.join(root, "agents", agentId, "sessions", "sessions.json"),
  env: process.env,
});

async function createSession(sessionId: string, agentId = "actor", key = sessionId) {
  const target = targetFor(sessionId, agentId, key);
  await owners.upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
  return target;
}

const closeDatabase = (databasePath: string) =>
  admit(() => owners.closeOpenClawAgentDatabaseByPath(databasePath));

function exportFts(database: { db: EngineConnection }, sessionId: string) {
  return Array.from(
    iterateSqliteQuerySync(
      database.db,
      owners.selectSessionTranscriptFtsRows(database.db, sessionId),
    ),
  );
}

async function queryRows<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  values?: unknown[],
) {
  return (await client.query<T>(sql, values)).rows;
}
if (connection) {
  owners = await loadOwners();
  openDatabase = createDatabaseOpener(owners);
}
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    if (!connection) {
      return;
    }
    try {
      if (owners) {
        admit(() => {
          for (const options of [
            { agentId: "main" },
            { agentId: "actor" },
            { agentId: "migration" },
            { agentId: "alternate", path: path.join(root, "explicit", "openclaw-agent.sqlite") },
            { agentId: "wrong-owner", path: path.join(root, "wrong-owner", "agent.sqlite") },
            { agentId: "drift", path: path.join(root, "drift", "agent.sqlite") },
          ]) {
            const database = owners.getOpenClawAgentDatabaseIfOpen(options);
            if (database) {
              owners.closeOpenClawAgentDatabaseByPath(database.path);
            }
          }
        });
        await owners.cleanupSessionStateForTest({ stateDir: root });
      }
      await dropPostgresTestSchemas(client, prefix);
    } finally {
      await client?.end();
      resetDatabaseEngineSelectionForTest();
      vi.unstubAllEnvs();
      cleanup();
    }
  }),
);

describe.skipIf(!connection)("PostgreSQL agent database owner", () => {
  beforeAll(async () => {
    root = tempDirs.make("agent-postgres-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    engineSelection.installDatabaseEngineSelection({
      effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
      postgres: { connection: connection!, schemaPrefix: prefix },
    });
    client = new pg.Client({ connectionString: connection });
    await client.connect();
    await client.query("CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public");
  });
  beforeEach(() => vi.stubEnv("OPENCLAW_STATE_DIR", root));

  it("inspects clean PostgreSQL transcripts and preserves history requiring a file repair backup", async () => {
    const target = await createSession("doctor-transcript", "doctor-transcripts", "main");
    await owners.appendTranscriptMessage(target, {
      message: { role: "assistant", content: "Keep [[literal]] text." },
      now: 1,
    });
    using database = openDatabase({ agentId: target.agentId });
    const inspect = () => {
      let result: ReturnType<typeof migrateHistoricalTranscriptDirectives> | undefined;
      admit(() => {
        result = migrateHistoricalTranscriptDirectives({
          env: process.env,
          preparedTargets: [
            {
              agentId: target.agentId,
              path: database.path,
              realPath: fs.realpathSync.native(database.path),
              source: "configured",
            },
          ],
        });
      });
      return result!;
    };
    expect(await inspect()).toEqual({ changes: [], warnings: [] });
    const eventQuery =
      "SELECT event_json FROM transcript_events WHERE message_role = 'assistant' LIMIT 1";
    const event = JSON.parse(String(database.get(eventQuery)?.event_json));
    event.message.content = [{ type: "text", text: "[[reply_to_current]] Legacy reply" }];
    const raw = JSON.stringify(event);
    database.write(
      "UPDATE transcript_events SET event_json = ? WHERE message_role = 'assistant'",
      raw,
    );
    expect(await inspect()).toEqual({
      changes: [],
      warnings: [expect.stringContaining("PostgreSQL cannot use SQLite repair")],
    });
    expect(database.get(eventQuery)).toEqual({ event_json: raw });
    expectAnchorOnly(database.path);
  });

  it("closes default and explicit stores with paired handles and a PostgreSQL receipt", () => {
    return admit(() => {
      for (const options of [
        { agentId: "main" },
        { agentId: "alternate", path: path.join(root, "explicit", "openclaw-agent.sqlite") },
      ]) {
        const database = openDatabase(options);
        assert(isPostgresSqlConnection(database.db));
        const anchor = database.db.anchor;
        closeReceipts.mockClear();
        expect(owners.closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
        expect([database.db.isOpen, anchor.isOpen]).toEqual([false, false]);
        expect(closeReceipts).toHaveBeenCalledWith(
          `agent database clean-close receipt: postgres-closed; agent=${options.agentId}`,
          expect.objectContaining({ agentId: options.agentId, receipt: "postgres-closed" }),
        );
      }
    });
  });

  it("migrates version 27 indexes and revision triggers while retaining rows and search", async () => {
    const target = targetFor("migration-session", "migration", "main");
    const memorySearch: SearchSchema = {
      text: {
        body: {
          table: "memory_index_chunks",
          fields: ["text"],
          postgres: { identity: "chunk_rowid" },
        },
      },
    };
    const assertMemorySearch = (db: EngineConnection) => {
      expect(
        db
          .prepare(`SELECT id, text FROM memory_index_chunks
            WHERE openclaw_search @@ plainto_tsquery('openclaw_simple_unaccent', 'cafe')`)
          .all(),
      ).toEqual([{ id: "migration-memory", text: "café optional memory" }]);
    };
    const options = { agentId: target.agentId };
    const databasePath = resolveOpenClawAgentSqlitePath(options);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const migration = agentEngineSchema.postgresMigrations!.find((step) => step.version === 28)!;
    const facts = admit(() => {
      using anchor = openNodeSqliteDatabase(databasePath);
      const db = openEngineStore({
        anchor,
        schema: {
          ...agentEngineSchema,
          version: 27,
          ...migration.fromSchema,
          postgresVectorDecoderVersion: migration.fromSchema.postgresVectorDecoderVersion,
        },
        input: { connection: connection!, schemaPrefix: prefix },
        inspectSqlite: () => ({ hasExistingData: false, hasEngineAnchor: false }),
        prepareAnchor() {},
        openSqlite() {
          throw new Error("Expected PostgreSQL");
        },
      });
      try {
        assert(isPostgresSqlConnection(db));
        db.runTransaction(() => {
          db.exec(`INSERT INTO schema_meta VALUES ('primary', 'agent', 27, 'migration', NULL, 1, 1);
            INSERT INTO session_key_contract (id, main_key, updated_at) VALUES (1, 'main', 0);
            INSERT INTO memory_index_state VALUES (1, 0);
            INSERT INTO session_nodes
            (session_key, current_session_id, entry_json, entry_valid, updated_at)
            VALUES ('${target.sessionKey}', '${target.sessionId}', '${JSON.stringify({ sessionId: target.sessionId, updatedAt: 1 })}', 1, 1);
            INSERT INTO session_windows
            (session_id, session_key, created_at, updated_at, transcript_updated_at)
            VALUES ('${target.sessionId}', '${target.sessionKey}', 1, 1, 1);
            INSERT INTO memory_entry_origins
            (entry_key, agent_id, session_id, session_key, origin_class, observed_at)
            VALUES ('retained-memory', '${target.agentId}', '${target.sessionId}', '${target.sessionKey}', 'agent', 1);
            INSERT INTO memory_index_chunks
            (chunk_rowid, id, path, start_line, end_line, hash, model, text, embedding, updated_at)
            VALUES (1, 'migration-memory', 'memory/migration.md', 1, 1, 'migration-hash',
              'text-only', 'café optional memory', decode('', 'hex'), 1);`);
          const insert = createTranscriptEventInserter(db, target.sessionId);
          for (const [seq, [id, parentId, role, content]] of (
            [
              ["migration-user", null, "user", "migration searchable archive"],
              ["migration-reply", "migration-user", "assistant", "migration retained reply"],
            ] as const
          ).entries()) {
            const event = { type: "message", id, parentId, message: { role, content } };
            insert({ seq, eventJson: JSON.stringify(event), createdAt: 1 });
            db.prepare(`INSERT INTO transcript_event_identities
              (session_id, event_id, seq, event_type, parent_id, created_at)
              VALUES (?, ?, ?, 'message', ?, 1)`).run(
              target.sessionId,
              event.id,
              seq,
              event.parentId,
            );
          }
          reconcileSessionTranscriptIndexInTransaction(db, target.sessionId);
        });
        owners.admitAgentEngineSearchExtensions(
          db,
          { "memory.text": memorySearch },
          () => undefined,
        );
        assertMemorySearch(db);
        const admitted = postgresFacts(db);
        assert(admitted);
        return admitted;
      } finally {
        db.close();
      }
    });
    try {
      const retained = await queryRows(
        `SELECT session_id, event_id, parent_id FROM "${facts.namespace}".transcript_event_identities ORDER BY seq`,
      );
      retireAdmission(databasePath);
      await client.query(`UPDATE "${facts.namespace}".openclaw_schema_meta
        SET fingerprint = NULL, ddl_hash = NULL, server_major = NULL;`);
      const owner = acquireGatewayStateOwner({ databasePath: resolveOpenClawStateSqlitePath() });
      const maintenance = createOpenClawDatabaseMaintenanceScope({
        schemaMaintenance: true,
        assertOwnerCurrent: owner.assertCurrent,
        assertDatabaseAccess: owner.assertDatabaseAccess,
      });
      try {
        await maintenance.run(() =>
          owners.withAgentDatabaseMaintenanceLease(
            { env: process.env, processBound: true, schemaPolicy: "existing" },
            async (lease) => {
              using anchor = openNodeSqliteDatabase(databasePath);
              lease.assertOwned();
              admit(() => {
                const engine = owners.openAgentEngineStore(
                  anchor,
                  target.agentId,
                  databasePath,
                  true,
                );
                if (engine !== anchor) {
                  engine.close();
                }
              });
            },
          ),
        );
      } finally {
        try {
          await maintenance.close();
        } finally {
          owner.release();
        }
      }
      const upgraded = openDatabase(options);
      assert(isPostgresSqlConnection(upgraded.db));
      expect(postgresFacts(upgraded.db)?.version).toBe(schemaVersion);
      admit(() => {
        assertMemorySearch(upgraded.db);
        expect(
          upgraded.get("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'"),
        ).toEqual({ schema_version: schemaVersion });
        expect(
          upgraded.get(
            "SELECT version, fingerprint, ddl_hash, server_major FROM openclaw_schema_meta",
          ),
        ).toEqual({
          version: schemaVersion,
          fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
          ddl_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
          server_major: facts.capabilities.serverMajor,
        });
      });
      expect(
        await queryRows(`SELECT revision FROM "${facts.namespace}".memory_index_state`),
      ).toEqual([{ revision: "1" }]);
      const navigationFunction = await queryRows(
        `SELECT p.proisstrict, p.proconfig FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = $1 AND p.proname = 'openclaw_transcript_navigation_check'`,
        [facts.namespace],
      );
      expect(navigationFunction).toEqual([
        { proisstrict: true, proconfig: ["search_path=pg_catalog"] },
      ]);
      expect(
        await queryRows(
          `SELECT session_id, event_id, parent_id FROM "${facts.namespace}".transcript_event_identities ORDER BY seq`,
        ),
      ).toEqual(retained);
      admit(() => {
        expect(
          upgraded.db.prepare("SELECT entry_key, origin_class FROM memory_entry_origins").all(),
        ).toEqual([{ entry_key: "retained-memory", origin_class: "agent" }]);
      });
      expect(await owners.searchSessionTranscripts({ ...target, query: "archive" })).toMatchObject({
        hits: [expect.objectContaining({ messageId: "migration-user" })],
      });
      closeDatabase(databasePath);
      await owners.closeOpenClawAgentDatabaseByPathAsync(databasePath);
      retireAdmission(databasePath);
      const reopened = openDatabase(options);
      expect(postgresFacts(reopened.db)?.version).toBe(schemaVersion);
      admit(() => assertMemorySearch(reopened.db));
    } finally {
      closeDatabase(databasePath);
      await owners.closeOpenClawAgentDatabaseByPathAsync(databasePath);
    }
  });

  it("appends and hydrates plain transcript JSON and drains interleaved turns through the agent worker in FIFO order", async () => {
    const {
      appendTranscriptMessage,
      prepareSessionTranscriptHydration,
      openContextEngineTurnOutboxWorkerStore,
      drainContextEngineTurnOutbox,
    } = owners;
    const target = await createSession("postgres-transcript");
    const append = (
      role: "user" | "assistant",
      content: string,
      parentId: string | undefined,
      now: number,
    ) => appendTranscriptMessage(target, { message: { role, content }, parentId, now });
    const boundaries: TranscriptTurnBoundary[] = [];
    let parentId: string | undefined;
    for (const [index, key] of ["z-first", "a-second", "m-third"].entries()) {
      const user = await append("user", `${key} ${"λ🦞".repeat(1_000)}`, parentId, index * 3 + 1);
      const intermediate =
        index === 0
          ? await append("assistant", `${key} progress`, user?.messageId, index * 3 + 2)
          : undefined;
      const reply = await append(
        "assistant",
        `${key} reply`,
        intermediate?.messageId ?? user?.messageId,
        index * 3 + 3,
      );
      assert(user?.anchor && reply?.anchor);
      boundaries.push({
        admission: { ...user.anchor, logicalTurnId: key, role: "user" },
        terminal: reply.anchor,
      });
      parentId = reply.messageId;
    }
    const database = openDatabase({ agentId: "actor" });
    assert(isPostgresSqlConnection(database.db));
    const facts = postgresFacts(database.db);
    assert(facts);
    const hydrated = await prepareSessionTranscriptHydration(target).read();
    const payloads = await queryRows<{ event_json: string; event_zstd: Buffer | null }>(
      `SELECT event_json, event_zstd FROM "${facts.namespace}".transcript_events ORDER BY seq`,
    );
    expect(
      payloads.every((row) => row.event_zstd === null && typeof row.event_json === "string"),
    ).toBe(true);
    expect(payloads.map((row) => JSON.parse(row.event_json))).toEqual(hydrated.snapshot.events);
    let store = openContextEngineTurnOutboxWorkerStore({ agentId: "actor", path: database.path });
    const filter = { engineId: "postgres-fixture" };
    const enqueue = (boundary: TranscriptTurnBoundary) =>
      store.enqueueIntent({ ...filter, admission: boundary.admission });
    const publish = async (boundary: TranscriptTurnBoundary) => {
      await store.acceptIntent({ ...filter, boundary });
      expect(
        await store.publishClosedTurn({ ...filter, boundary, maxBytes: 100_000, maxEvents: 10 }),
      ).toBe("ok");
    };
    await enqueue(boundaries[0]!);
    await enqueue(boundaries[1]!);
    await publish(boundaries[0]!);
    await enqueue(boundaries[2]!);
    await publish(boundaries[1]!);
    await publish(boundaries[2]!);
    const queued = await queryRows<{ advancement_key: string; enqueue_sequence: string }>(
      `SELECT advancement_key, enqueue_sequence FROM "${facts.namespace}".context_engine_turn_outbox ORDER BY enqueue_sequence`,
    );
    expect(queued.map((row) => row.advancement_key)).toEqual(["z-first", "a-second", "m-third"]);
    expect(queued.map((row) => Number(row.enqueue_sequence))).toEqual([1, 2, 3]);
    closeDatabase(database.path);
    await owners.cleanupSessionStateForTest({ stateDir: root });
    // Reverse timestamps under exclusive fixture custody: a timestamp sorter
    // would now deliver third first, while durable enqueue order must survive.
    await client.query(
      `UPDATE "${facts.namespace}".context_engine_turn_outbox SET created_at = 4 - enqueue_sequence`,
    );
    store = openContextEngineTurnOutboxWorkerStore({ agentId: "actor", path: database.path });
    const committed: string[] = [];
    const engine: ContextEngine = {
      info: { id: filter.engineId, name: "PostgreSQL fixture" },
      ingest: async () => ({ ingested: true }),
      assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
      compact: async () => ({ ok: true, compacted: false }),
      commitTurn: async ({ advancementKey, messages }) => {
        committed.push(advancementKey);
        expect(messages.map((message) => message.role)).toEqual(
          advancementKey === "z-first" ? ["user", "assistant", "assistant"] : ["user", "assistant"],
        );
        return { status: "committed" };
      },
    };
    const warn = vi.fn();
    expect(
      await drainContextEngineTurnOutbox({ store, engine, engineId: filter.engineId, warn }),
    ).toEqual({ pending: false });
    expect(committed).toEqual(["z-first", "a-second", "m-third"]);
    expect(warn).not.toHaveBeenCalled();
    expect(
      await queryRows(`SELECT count(*) FROM "${facts.namespace}".context_engine_turn_outbox`),
    ).toEqual([{ count: "0" }]);
  });

  it("preserves FTS row identity for nullable and repeated IDs across bounded inserts", async () => {
    const count = 515;
    const sessionId = `fts-identities-${count}`;
    const options = { agentId: "actor" };
    const database = openDatabase(options);
    const postgres = database.db;
    assert(isPostgresSqlConnection(postgres));
    const facts = postgresFacts(postgres);
    assert(facts);
    // Cold restoration preserves these nullable/repeated stored IDs; normal
    // transcript append filters absent IDs and deduplicates event identities.
    const entries = Array.from({ length: count }, (_, index) => ({
      messageId: index % 4 < 2 ? null : "repeated",
      text: `ftskeytoken${index}`,
      role: index % 2 ? "assistant" : "user",
      timestamp: index,
    }));
    let statements = 0;
    const observation = channel("openclaw.database.statement");
    const observe = (value: unknown) => {
      if (isRecord(value) && value.engine === "postgres") {
        statements += 1;
      }
    };
    admit(() =>
      owners.runOpenClawAgentWriteTransaction(({ db }) => {
        const insert = owners.createSessionTranscriptFtsInserter(db, sessionId);
        observation.subscribe(observe);
        try {
          insert(entries);
        } finally {
          observation.unsubscribe(observe);
        }
      }, options),
    );
    const persisted = await queryRows(
      `SELECT r.id, r.id = f.rowid AS same_id, r.message_id AS owner_message_id,
          f.message_id, f.text, f.role, f.timestamp
          FROM "${facts.namespace}".session_transcript_fts_rows r
          LEFT JOIN "${facts.namespace}".session_transcript_fts f ON f.rowid = r.id
          WHERE r.session_id = $1 ORDER BY f.timestamp`,
      [sessionId],
    );
    const expected = entries.map(({ messageId, ...entry }) => ({
      message_id: messageId,
      ...entry,
    }));
    expect(persisted.map(({ id: _id, ...row }) => row)).toEqual(
      expected.map((entry) => ({ same_id: true, owner_message_id: entry.message_id, ...entry })),
    );
    const ids = persisted.map((row) => BigInt(row.id));
    for (let index = 1; index < ids.length; index++) {
      expect(ids[index]).toBeGreaterThan(ids[index - 1]!);
    }
    expect(admit(() => exportFts(database, sessionId))).toEqual(expected);
    // Each observed PostgreSQL statement makes one bridge/server request.
    expect(statements).toBe(2);
    admit(() => {
      // Keep the first bridge open so the pooled writer uses another backend.
      const next = owners.openAgentEngineStore(
        postgres.anchor,
        options.agentId,
        database.path,
        true,
      );
      assert(isPostgresSqlConnection(next));
      try {
        expect(next.prepare("SELECT pg_backend_pid() AS pid").get()?.pid).not.toBe(
          postgres.prepare("SELECT pg_backend_pid() AS pid").get()?.pid,
        );
        next.runTransaction(() =>
          owners.createSessionTranscriptFtsInserter(next, `${sessionId}-next`)(entries.slice(0, 2)),
        );
        const later = next
          .prepare("SELECT id FROM session_transcript_fts_rows WHERE session_id = ? ORDER BY id")
          .all(`${sessionId}-next`);
        expect(later).toHaveLength(2);
        expect(BigInt(String(later[0]!.id))).toBeGreaterThan(ids.at(-1)!);
        expect(BigInt(String(later[1]!.id))).toBeGreaterThan(BigInt(String(later[0]!.id)));
      } finally {
        next.close();
      }
    });
  });

  it("preserves recent-search cutoffs and cold-export order for equal-timestamp batches", () => {
    const events = Array.from({ length: 130 }, (_, index) => ({
      type: "message",
      id: `ordered-${index}`,
      parentId: index === 0 ? null : `ordered-${index - 1}`,
      timestamp: 1,
      message: { role: "user", content: `chronologyneedle entry ${index}` },
    }));
    admit(() => {
      const options = { agentId: "actor" };
      const target = {
        ...options,
        sessionId: "fts-chronology",
        sessionKey: "agent:actor:fts-chronology",
      };
      using database = openDatabase(options);
      owners.runOpenClawAgentWriteTransaction((writer) => {
        expect(
          owners.appendTranscriptEventsInTransaction(writer, target, events, {
            scheduleProjectionReconcile: false,
          }),
        ).toBe(events.length);
      }, options);
      expect(exportFts(database, target.sessionId).map((row) => row.message_id)).toEqual(
        events.map((event) => event.id),
      );
      for (const limit of [1, 3, 25]) {
        const result = owners.searchSessionTranscriptsReadOnlySync(
          { ...target, query: "chronologyneedle", order: "recent", limit },
          { ...options, path: database.path },
        );
        expect(result.hits.map((hit) => hit.messageId)).toEqual(
          events
            .slice(-limit)
            .toReversed()
            .map((event) => event.id),
        );
      }
    });
  });

  it.each(["ownership", "schema drift"])("refuses changed %s after readmission", async (change) => {
    const agentId = change === "ownership" ? "wrong-owner" : "drift";
    const options = { agentId, path: path.join(root, agentId, "agent.sqlite") };
    const database = openDatabase(options);
    assert(isPostgresSqlConnection(database.db));
    const facts = postgresFacts(database.db);
    assert(facts);
    closeDatabase(database.path);
    retireAdmission(database.path);
    await client.query(
      change === "ownership"
        ? `UPDATE "${facts.namespace}".schema_meta SET agent_id = 'different'`
        : `ALTER TABLE "${facts.namespace}".cache_entries ADD COLUMN unexpected TEXT`,
    );
    expect(() => openDatabase(options)).toThrow(
      change === "ownership"
        ? /belongs to agent different; requested agent wrong-owner/
        : /schema drift/i,
    );
  });
});
