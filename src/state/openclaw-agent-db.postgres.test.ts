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
import * as doctorEntries from "../commands/doctor/shared/session-entry-rewrite.js";
import { migrateLegacySessionEntryState } from "../commands/doctor/shared/session-entry-shape.js";
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
import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import { retireSqliteDatabaseAdmissionForPath as retireAdmission } from "../infra/sqlite-database-admission.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { migrateHistoricalTranscriptDirectives } from "../infra/state-migrations.transcript-directives.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION as schemaVersion } from "./openclaw-agent-db-contract.js";
import { agentEngineSchema } from "./openclaw-agent-db-engine.js";
import { readOpenClawAgentDatabaseIdentity as readIdentity } from "./openclaw-agent-db-identity.js";
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

async function inspectSchema(pathname: string, agentId?: string) {
  await using inspector = owners.createAgentSchemaInspectionWorker();
  const result = await inspector.inspect({
    pathname,
    ...(agentId ? { agentId } : {}),
    env: process.env,
    supportedVersion: schemaVersion,
    verifyCurrentSchemaShape: true,
    inspectOwnership: true,
    requireStartupMigrationReadiness: true,
  });
  expect(inspector).toMatchObject({ snapshotCount: 0, processCount: 1 });
  return result;
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
      const schemas = await queryRows<{ nspname: string }>(
        "SELECT nspname FROM pg_namespace WHERE left(nspname, $1) = $2",
        [prefix.length + 1, `${prefix}_`],
      );
      for (const { nspname } of schemas) {
        await client.query(`DROP SCHEMA "${nspname.replaceAll('"', '""')}" CASCADE`);
      }
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

  it("reads persisted model catalogs through the worker without local application tables", async () => {
    const { loadPersistedPluginModelCatalogs } =
      await import("../agents/plugin-model-catalog-execution.js");
    const agentId = "model-catalog";
    const contents = JSON.stringify({ providers: { fixture: { models: [{ id: "synthetic" }] } } });
    const database = openDatabase({ agentId });
    database.write(
      "INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES (?, ?, ?, ?)",
      "plugin-model-catalog-v1",
      "fixture",
      contents,
      1,
    );
    const databasePath = database.path;
    closeDatabase(databasePath);
    expect(await loadPersistedPluginModelCatalogs(path.dirname(databasePath), ["fixture"])).toEqual(
      [{ pluginId: "fixture", contents }],
    );
    expectAnchorOnly(databasePath);
  });

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

  it("scans and repairs legacy Doctor state while retaining opaque PostgreSQL JSON numbers", () => {
    admit(() => {
      using database = openDatabase({ agentId: "doctor" });
      const sessionKey = "agent:doctor:main";
      const raw =
        '{"sessionId":"doctor-session","updatedAt":42,"status":"queued","pendingFinalDelivery":true,"pendingFinalDeliveryText":"saved reply","opaqueCount":9007199254740993,"opaque":{"value":123456789012345678901234567890,"label":"retained"}}';
      database.run(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
        sessionKey,
        "doctor-session",
        raw,
        42,
      );
      database.run(
        "INSERT INTO session_windows (session_id, session_key, session_scope, created_at, updated_at) VALUES (?, ?, 'conversation', ?, ?)",
        "doctor-session",
        sessionKey,
        42,
        42,
      );
      const scope = { agentId: "doctor", storePath: database.path };
      const expectedIdentity = readDatabasePathIdentitySync(database.path);
      const scanned: Array<{ sessionKey: string; entry: Record<string, unknown> }> = [];
      doctorEntries.scanDoctorSessionEntryRecords(
        scope,
        (record) => scanned.push(record),
        expectedIdentity,
      );
      expect(scanned).toEqual([
        {
          sessionKey,
          entry: expect.objectContaining({ status: "queued", pendingFinalDelivery: true }),
        },
      ]);
      expect(
        doctorEntries.rewriteDoctorSessionEntries({
          scope,
          sessionKeys: [sessionKey],
          expectedIdentity,
          rawTransform: (entry, key, updatedAt) =>
            migrateLegacySessionEntryState(entry, updatedAt, key),
        }),
      ).toBe(1);
      const repairedRaw = database.get(
        "SELECT entry_json FROM session_nodes WHERE session_key = ?",
        sessionKey,
      )?.entry_json;
      assert(typeof repairedRaw === "string");
      expect(JSON.parse(repairedRaw)).toMatchObject({
        sessionId: "doctor-session",
        updatedAt: 42,
        status: "interrupted",
        pendingFinalDelivery: { kind: "replayable", text: "saved reply", createdAt: 42 },
        opaque: { label: "retained" },
      });
      expect(repairedRaw).not.toContain("pendingFinalDeliveryText");
      expect(repairedRaw).toContain("9007199254740993");
      expect(repairedRaw).toContain("123456789012345678901234567890");
      expectAnchorOnly(database.path);
    });
  });

  it("opens default and explicit stores, retains identity, and closes both handles", () => {
    return admit(() => {
      for (const options of [
        { agentId: "main" },
        { agentId: "alternate", path: path.join(root, "explicit", "openclaw-agent.sqlite") },
      ]) {
        const database = openDatabase(options);
        assert(isPostgresSqlConnection(database.db));
        const facts = postgresFacts(database.db);
        expect(facts).toMatchObject({ store: "agent", version: schemaVersion });
        expect(
          database.get(
            "SELECT agent_id, role, schema_version FROM schema_meta WHERE meta_key = 'primary'",
          ),
        ).toEqual({ agent_id: options.agentId, role: "agent", schema_version: schemaVersion });
        const identity = readIdentity(database);
        const retained = owners.retainOpenClawAgentDatabaseReadOnly(options);
        assert(retained.found);
        expect(retained.claim.identity).toBe(identity.identity);
        expect(retained.claim.isCurrent()).toBe(true);
        retained.claim.release();
        const anchor = database.db.anchor;
        closeReceipts.mockClear();
        expect(owners.closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
        expect([database.db.isOpen, anchor.isOpen]).toEqual([false, false]);
        expect(closeReceipts).toHaveBeenCalledWith(
          `agent database clean-close receipt: postgres-closed; agent=${options.agentId}`,
          expect.objectContaining({ agentId: options.agentId, receipt: "postgres-closed" }),
        );
        const reopened = owners.openOpenClawAgentDatabase(options);
        assert(isPostgresSqlConnection(reopened.db));
        expect(postgresFacts(reopened.db)?.namespace).toBe(facts?.namespace);
        expect(readIdentity(reopened).identity).toBe(identity.identity);
        expect(readIdentity(reopened).incarnation).not.toBe(identity.incarnation);
        closeDatabase(reopened.path);
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
      const extensions = db.prepare("SELECT search_extensions FROM openclaw_schema_meta").get();
      expect(JSON.parse(String(extensions?.search_extensions))).toEqual({
        "memory.text": memorySearch,
      });
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
          postgres: migration.fromSchema.postgres,
          postgresMigrations: [],
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
      const indexes = await queryRows(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1
          AND indexname IN ('idx_agent_session_windows_conversation', 'idx_agent_transcript_event_parent',
            'idx_agent_session_nodes_last_interaction_at', 'idx_agent_session_reactions_message')`,
        [facts.namespace],
      );
      expect(indexes).toEqual([
        {
          indexname: "idx_agent_session_windows_conversation",
          indexdef: `CREATE INDEX idx_agent_session_windows_conversation ON ${facts.namespace}.session_windows USING btree (primary_conversation_id NULLS FIRST) WHERE (primary_conversation_id IS NOT NULL)`,
        },
      ]);
      expect(
        await queryRows(
          `SELECT p.proname FROM pg_proc p
              JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = $1 AND p.proname IN
                ('openclaw_memory_index_sources_trigger', 'openclaw_memory_index_chunks_trigger')`,
          [facts.namespace],
        ),
      ).toEqual([]);
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

  it("discovers a cold explicit store owner through the selected reader worker", async () => {
    const pathname = path.join(root, "explicit", "openclaw-agent.sqlite");
    admit(() => {
      owners.openOpenClawAgentDatabase({ agentId: "alternate", path: pathname });
      owners.closeOpenClawAgentDatabaseByPath(pathname);
    });
    await owners.closeOpenClawAgentDatabaseByPathAsync(pathname);
    const { readActiveOpenClawAgentDatabaseLeasesReadOnly } =
      await import("./openclaw-agent-db-lease.js");
    const activeLeases = () =>
      admit(() =>
        readActiveOpenClawAgentDatabaseLeasesReadOnly({ env: process.env }).filter(
          (lease) => lease.path === pathname,
        ),
      );
    expect(activeLeases()).toEqual([]);
    retireAdmission(pathname);
    expect(await inspectSchema(pathname)).toMatchObject({
      agentSchemaMeta: { agentId: "alternate", role: "agent", schemaVersion },
    });
    expect(activeLeases()).toEqual([]);
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
    const hydrated = await prepareSessionTranscriptHydration(target).read();
    expect(
      hydrated.snapshot.events.filter((event) => isRecord(event) && event.type === "message"),
    ).toHaveLength(7);
    expect(await owners.searchSessionTranscripts({ ...target, query: "progress" })).toMatchObject({
      hits: [
        {
          sessionId: target.sessionId,
          sessionKey: target.sessionKey,
          role: "assistant",
          snippet: expect.stringContaining("progress"),
        },
      ],
      indexing: false,
    });
    const database = openDatabase({ agentId: "actor" });
    assert(isPostgresSqlConnection(database.db));
    const facts = postgresFacts(database.db);
    assert(facts);
    expect(await inspectSchema(database.path, "actor")).toMatchObject({
      version: schemaVersion,
      agentSchemaMeta: { agentId: "actor", role: "agent", schemaVersion },
    });
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

  it("searches active branches through the worker with session and role filters and lifecycle deletion", async () => {
    const target = targetFor("search-branch");
    const sibling = {
      ...target,
      sessionId: "search-sibling",
      sessionKey: "agent:actor:search-sibling",
    };
    for (const scope of [target, sibling]) {
      await owners.upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    }
    await owners.appendTranscriptMessage(target, {
      eventId: "search-user",
      parentId: null,
      message: { role: "user", content: "searchable alpha origin" },
    });
    await owners.appendTranscriptMessage(target, {
      eventId: "search-assistant",
      parentId: "search-user",
      message: { role: "assistant", content: "searchable beta abandoned" },
    });
    await owners.appendTranscriptMessage(sibling, {
      eventId: "search-sibling-user",
      message: { role: "user", content: "searchable survivor" },
    });
    const search = {
      agentId: target.agentId,
      storePath: target.storePath,
      env: process.env,
      query: "searchable",
      sessionKeys: [target.sessionKey, sibling.sessionKey],
    };
    const find = (overrides: Partial<Parameters<typeof owners.searchSessionTranscripts>[0]> = {}) =>
      owners.searchSessionTranscripts({ ...search, ...overrides });
    expect((await find({ role: "assistant" })).hits).toEqual([
      expect.objectContaining({ messageId: "search-assistant" }),
    ]);
    expect((await find({ sessionId: sibling.sessionId })).hits).toEqual([
      expect.objectContaining({ messageId: "search-sibling-user" }),
    ]);
    expect(
      (await find({ sessionKeys: [target.sessionKey] })).hits
        .map((hit) => hit.messageId)
        .toSorted(),
    ).toEqual(["search-assistant", "search-user"]);
    await owners.appendTranscriptEvent(target, {
      type: "leaf",
      id: "search-leaf",
      parentId: "search-assistant",
      targetId: "search-user",
    });
    expect((await find({ query: "beta" })).hits).toEqual([]);
    const options = { agentId: target.agentId, env: process.env };
    await owners.waitForSessionTranscriptIndexReconcile(options);
    if ((await find()).indexing) {
      await owners.reconcileSessionTranscriptIndexes(options);
    }
    expect(await find({ query: "alpha" })).toMatchObject({
      hits: [expect.objectContaining({ messageId: "search-user" })],
      indexing: false,
    });
    expect((await find({ query: "beta" })).hits).toEqual([]);
    const removal = {
      ...target,
      target: { canonicalKey: target.sessionKey, storeKeys: [target.sessionKey] },
      archiveTranscript: false,
      deleteTranscriptWithoutArchive: true,
    };
    await owners.upsertSessionEntryCore(sibling, { previousSessionId: target.sessionId });
    expect(await owners.deleteSessionEntryLifecycle(removal)).toMatchObject({ deleted: true });
    expect((await find({ query: "alpha" })).hits).toEqual([
      expect.objectContaining({ sessionId: target.sessionId, messageId: "search-user" }),
    ]);
    await owners.upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 2 });
    await owners.upsertSessionEntryCore(sibling, { previousSessionId: undefined });
    expect(
      await owners.deleteSessionEntryLifecycle({ ...removal, archiveTranscript: true }),
    ).toMatchObject({ deleted: true, archivedTranscripts: [expect.anything()] });
    expect((await find()).hits).toEqual([
      expect.objectContaining({ sessionId: sibling.sessionId, messageId: "search-sibling-user" }),
    ]);
  });

  it("indexes only accepted searchable messages from a transcript append batch", async () => {
    const target = await createSession("fts-append-batch");
    function event(id: string, parentId: string | null, role: string, content: string) {
      return { type: "message", id, parentId, timestamp: 1, message: { role, content } };
    }
    admit(() =>
      owners.runOpenClawAgentWriteTransaction(
        (database) => {
          expect(
            owners.appendTranscriptEventsInTransaction(database, target, [
              event("batch-user", null, "user", "batchneedle accepted origin"),
              event("batch-user", null, "user", "batchneedle rejected duplicate"),
              event("batch-tool", "batch-user", "toolResult", "batchneedle hidden tool"),
              event("batch-reply", "batch-tool", "assistant", "batchneedle accepted reply"),
            ]),
          ).toBe(3);
        },
        { agentId: target.agentId },
      ),
    );
    const search = (query: string) => owners.searchSessionTranscripts({ ...target, query });
    expect((await search("batchneedle")).hits.map((hit) => hit.messageId).toSorted()).toEqual([
      "batch-reply",
      "batch-user",
    ]);
    expect((await search("rejected")).hits).toEqual([]);
    expect((await search("hidden")).hits).toEqual([]);
  });

  it.each([4, 515])(
    "preserves FTS row identity for %i nullable and repeated message IDs in bounded statements",
    async (count) => {
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
      for (const index of [0, 1, 2, 3]) {
        const searched = await queryRows(
          `SELECT message_id, text FROM "${facts.namespace}".session_transcript_fts
            WHERE session_id = $1 AND openclaw_search @@
              plainto_tsquery('"${facts.namespace}".openclaw_simple_unaccent', $2)`,
          [sessionId, `ftskeytoken${index}`],
        );
        expect(searched).toEqual([
          { message_id: index < 2 ? null : "repeated", text: `ftskeytoken${index}` },
        ]);
      }
      // Each observed PostgreSQL statement makes one bridge/server request.
      expect(statements).toBe(count === 4 ? 1 : 2);
      if (count > 512) {
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
              owners.createSessionTranscriptFtsInserter(
                next,
                `${sessionId}-next`,
              )(entries.slice(0, 2)),
            );
            const later = next
              .prepare(
                "SELECT id FROM session_transcript_fts_rows WHERE session_id = ? ORDER BY id",
              )
              .all(`${sessionId}-next`);
            expect(later).toHaveLength(2);
            expect(BigInt(String(later[0]!.id))).toBeGreaterThan(ids.at(-1)!);
            expect(BigInt(String(later[1]!.id))).toBeGreaterThan(BigInt(String(later[0]!.id)));
          } finally {
            next.close();
          }
        });
      }
    },
  );

  it("matches SQLite recent-search cutoffs and cold-export order for equal-timestamp batches", () => {
    const events = Array.from({ length: 130 }, (_, index) => ({
      type: "message",
      id: `ordered-${index}`,
      parentId: index === 0 ? null : `ordered-${index - 1}`,
      timestamp: 1,
      message: { role: "user", content: `chronologyneedle entry ${index}` },
    }));
    const results = (["sqlite", "postgres"] as const).map((engine) =>
      engineSelection.withDatabaseEngineSelection(
        {
          effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine } }),
          postgres: { connection: connection!, schemaPrefix: prefix },
        },
        () =>
          admit(() => {
            const options = {
              agentId: "actor",
              ...(engine === "sqlite"
                ? { path: path.join(root, "sqlite-fts-order", "agent.sqlite") }
                : {}),
            };
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
            const exported = exportFts(database, target.sessionId);
            expect(exported.map((row) => row.message_id)).toEqual(events.map((event) => event.id));
            return [1, 3, 25].map((limit) => {
              const result = owners.searchSessionTranscriptsReadOnlySync(
                { ...target, query: "chronologyneedle", order: "recent", limit },
                { ...options, path: database.path },
              );
              const ids = result.hits.map((hit) => hit.messageId);
              expect(ids).toEqual(
                events
                  .slice(-limit)
                  .toReversed()
                  .map((event) => event.id),
              );
              return ids;
            });
          }),
      ),
    );
    expect(results[1]).toEqual(results[0]);
  });

  it("reads persisted auth through the selected owner and agent worker", async () => {
    const store = {
      version: 1,
      profiles: { fixture: { type: "api_key", provider: "fixture", key: "synthetic" } },
    };
    for (const options of [
      { agentId: "main" },
      { agentId: "alternate", path: path.join(root, "explicit", "openclaw-agent.sqlite") },
    ]) {
      const database = openDatabase(options);
      admit(() =>
        owners.runOpenClawAgentWriteTransaction(
          ({ db }) => owners.writeAuthProfileJsonCell(db, "store", "agent", store),
          options,
        ),
      );
      expect(
        admit(() => owners.inspectPersistedAuthProfileStoreRaw(path.dirname(database.path))),
      ).toEqual({ status: "readable", raw: store });
      closeDatabase(database.path);
      await owners.closeOpenClawAgentDatabaseByPathAsync(database.path);
      const reader = owners.prepareAgentAuthProfileRowsRead({
        databasePath: database.path,
        agentId: options.agentId,
        env: process.env,
      });
      try {
        expect((await reader.read()).store).toEqual({ status: "readable", raw: store });
      } finally {
        await reader.dispose();
      }
    }
    const sharedMainPath = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
    await owners.closeOpenClawAgentDatabaseByPathAsync(sharedMainPath);
    retireAdmission(sharedMainPath);
    expect(
      await owners.prepareFreshSharedAuthStoreWriteAsync({
        agentDir: undefined,
        allowExplicitMain: false,
        env: process.env,
      }),
    ).toBe(true);
    expect(owners.resolveSharedAuthStoreOwnership(process.env)).toEqual({
      location: "legacy-main",
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
