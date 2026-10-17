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
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import {
  installDatabaseEngineSelection,
  withDatabaseEngineSelection,
} from "../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import type { SearchSchema } from "../infra/database-engine/contract.js";
import { openEngineStore } from "../infra/database-engine/open.js";
import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { iterateSqliteQuerySync } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import { retireSqliteDatabaseAdmissionForPath } from "../infra/sqlite-database-admission.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { agentEngineSchema } from "./openclaw-agent-db-engine.js";
import { readOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { loadOwners } from "./openclaw-agent-db.postgres.test-support.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const configured: unknown = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const prefix = `agenttest_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
let root: string;
let client: pg.Client;
let owners: Awaited<ReturnType<typeof loadOwners>>;
if (connection) {
  owners = await loadOwners();
}
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    if (!connection) {
      return;
    }
    try {
      if (owners) {
        withEngineStoreAdmission(() => {
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
      const schemas = await client.query<{ nspname: string }>(
        "SELECT nspname FROM pg_namespace WHERE left(nspname, $1) = $2",
        [prefix.length + 1, `${prefix}_`],
      );
      for (const { nspname } of schemas.rows) {
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
    installDatabaseEngineSelection({
      effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
      postgres: { connection: connection!, schemaPrefix: prefix },
    });
    client = new pg.Client({ connectionString: connection });
    await client.connect();
    await client.query("CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public");
  });
  beforeEach(() => vi.stubEnv("OPENCLAW_STATE_DIR", root));

  it("opens default and explicit stores, retains identity, and closes both handles", () => {
    return withEngineStoreAdmission(() => {
      const {
        openOpenClawAgentDatabase,
        closeOpenClawAgentDatabaseByPath,
        retainOpenClawAgentDatabaseReadOnly,
      } = owners;
      for (const options of [
        { agentId: "main" },
        { agentId: "alternate", path: path.join(root, "explicit", "openclaw-agent.sqlite") },
      ]) {
        const database = openOpenClawAgentDatabase(options);
        assert(isPostgresSqlConnection(database.db));
        const facts = getPostgresPhysicalFacts(database.db);
        expect(facts).toMatchObject({ store: "agent", version: OPENCLAW_AGENT_SCHEMA_VERSION });
        expect(
          database.db
            .prepare(
              "SELECT agent_id, role, schema_version FROM schema_meta WHERE meta_key = 'primary'",
            )
            .get(),
        ).toEqual({
          agent_id: options.agentId,
          role: "agent",
          schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
        });
        const identity = readOpenClawAgentDatabaseIdentity(database);
        const retained = retainOpenClawAgentDatabaseReadOnly(options);
        assert(retained.found);
        expect(retained.claim.identity).toBe(identity.identity);
        expect(retained.claim.isCurrent()).toBe(true);
        retained.claim.release();
        const anchor = database.db.anchor;
        expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
        expect(database.db.isOpen).toBe(false);
        expect(anchor.isOpen).toBe(false);
        const reopened = openOpenClawAgentDatabase(options);
        assert(isPostgresSqlConnection(reopened.db));
        expect(getPostgresPhysicalFacts(reopened.db)?.namespace).toBe(facts?.namespace);
        expect(readOpenClawAgentDatabaseIdentity(reopened).identity).toBe(identity.identity);
        expect(readOpenClawAgentDatabaseIdentity(reopened).incarnation).not.toBe(
          identity.incarnation,
        );
        closeOpenClawAgentDatabaseByPath(reopened.path);
      }
    });
  });

  it("migrates version 27 indexes and navigation validation while retaining rows and search", async () => {
    const target = {
      agentId: "migration",
      sessionId: "migration-session",
      sessionKey: "agent:migration:main",
      storePath: path.join(root, "agents", "migration", "sessions", "sessions.json"),
    };
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
        JSON.parse(
          String(
            db.prepare("SELECT search_extensions FROM openclaw_schema_meta").get()
              ?.search_extensions,
          ),
        ),
      ).toEqual({ "memory.text": memorySearch });
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
    const facts = withEngineStoreAdmission(() => {
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
            INSERT INTO memory_index_state VALUES (1, 0);`);
          db.prepare(`INSERT INTO session_nodes
            (session_key, current_session_id, entry_json, entry_valid, updated_at)
            VALUES (?, ?, ?, 1, 1)`).run(
            target.sessionKey,
            target.sessionId,
            JSON.stringify({ sessionId: target.sessionId, updatedAt: 1 }),
          );
          db.prepare(`INSERT INTO session_windows
            (session_id, session_key, created_at, updated_at, transcript_updated_at)
            VALUES (?, ?, 1, 1, 1)`).run(target.sessionId, target.sessionKey);
          db.prepare(`INSERT INTO memory_entry_origins
            (entry_key, agent_id, session_id, session_key, origin_class, observed_at)
            VALUES (?, ?, ?, ?, 'agent', 1)`).run(
            "retained-memory",
            target.agentId,
            target.sessionId,
            target.sessionKey,
          );
          db.prepare(`INSERT INTO memory_index_chunks
            (chunk_rowid, id, path, start_line, end_line, hash, model, text, embedding, updated_at)
            VALUES (1, 'migration-memory', 'memory/migration.md', 1, 1, 'migration-hash',
              'text-only', 'café optional memory', ?, 1)`).run(new Uint8Array());
          const insert = createTranscriptEventInserter(db, target.sessionId);
          for (const [seq, event] of [
            {
              type: "message",
              id: "migration-user",
              parentId: null,
              message: { role: "user", content: "migration searchable archive" },
            },
            {
              type: "message",
              id: "migration-reply",
              parentId: "migration-user",
              message: { role: "assistant", content: "migration retained reply" },
            },
          ].entries()) {
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
        const admitted = getPostgresPhysicalFacts(db);
        assert(admitted);
        return admitted;
      } finally {
        db.close();
      }
    });
    try {
      const retained = await client.query(
        `SELECT session_id, event_id, parent_id FROM "${facts.namespace}".transcript_event_identities ORDER BY seq`,
      );
      retireSqliteDatabaseAdmissionForPath(databasePath);
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
              withEngineStoreAdmission(() => {
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
      const upgraded = withEngineStoreAdmission(() => owners.openOpenClawAgentDatabase(options));
      assert(isPostgresSqlConnection(upgraded.db));
      expect(getPostgresPhysicalFacts(upgraded.db)?.version).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
      withEngineStoreAdmission(() => {
        assertMemorySearch(upgraded.db);
        expect(
          upgraded.db
            .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
            .get(),
        ).toEqual({ schema_version: OPENCLAW_AGENT_SCHEMA_VERSION });
        expect(
          upgraded.db
            .prepare(
              "SELECT version, fingerprint, ddl_hash, server_major FROM openclaw_schema_meta",
            )
            .get(),
        ).toEqual({
          version: OPENCLAW_AGENT_SCHEMA_VERSION,
          fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
          ddl_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
          server_major: facts.capabilities.serverMajor,
        });
      });
      const indexes = await client.query(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1
          AND indexname IN ('idx_agent_session_windows_conversation', 'idx_agent_transcript_event_parent',
            'idx_agent_session_nodes_last_interaction_at', 'idx_agent_session_reactions_message')`,
        [facts.namespace],
      );
      expect(indexes.rows).toEqual([
        {
          indexname: "idx_agent_session_windows_conversation",
          indexdef: `CREATE INDEX idx_agent_session_windows_conversation ON ${facts.namespace}.session_windows USING btree (primary_conversation_id NULLS FIRST) WHERE (primary_conversation_id IS NOT NULL)`,
        },
      ]);
      const navigationFunction = await client.query(
        `SELECT p.proisstrict, p.proconfig FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = $1 AND p.proname = 'openclaw_transcript_navigation_check'`,
        [facts.namespace],
      );
      expect(navigationFunction.rows).toEqual([
        { proisstrict: true, proconfig: ["search_path=pg_catalog"] },
      ]);
      expect(
        (
          await client.query(
            `SELECT session_id, event_id, parent_id FROM "${facts.namespace}".transcript_event_identities ORDER BY seq`,
          )
        ).rows,
      ).toEqual(retained.rows);
      withEngineStoreAdmission(() => {
        expect(
          upgraded.db.prepare("SELECT entry_key, origin_class FROM memory_entry_origins").all(),
        ).toEqual([{ entry_key: "retained-memory", origin_class: "agent" }]);
      });
      expect(
        await owners.searchSessionTranscripts({ ...target, query: "archive", env: process.env }),
      ).toMatchObject({ hits: [expect.objectContaining({ messageId: "migration-user" })] });
      withEngineStoreAdmission(() => owners.closeOpenClawAgentDatabaseByPath(databasePath));
      await owners.closeOpenClawAgentDatabaseByPathAsync(databasePath);
      retireSqliteDatabaseAdmissionForPath(databasePath);
      const reopened = withEngineStoreAdmission(() => owners.openOpenClawAgentDatabase(options));
      expect(getPostgresPhysicalFacts(reopened.db)?.version).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
      withEngineStoreAdmission(() => assertMemorySearch(reopened.db));
    } finally {
      withEngineStoreAdmission(() => owners.closeOpenClawAgentDatabaseByPath(databasePath));
      await owners.closeOpenClawAgentDatabaseByPathAsync(databasePath);
    }
  });

  it("discovers a cold explicit store owner through the selected reader worker", async () => {
    const pathname = path.join(root, "explicit", "openclaw-agent.sqlite");
    withEngineStoreAdmission(() => {
      owners.openOpenClawAgentDatabase({ agentId: "alternate", path: pathname });
      owners.closeOpenClawAgentDatabaseByPath(pathname);
    });
    retireSqliteDatabaseAdmissionForPath(pathname);
    await using inspector = owners.createAgentSchemaInspectionWorker();
    expect(
      await inspector.inspect({
        pathname,
        env: process.env,
        supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
        verifyCurrentSchemaShape: true,
        inspectOwnership: true,
        requireStartupMigrationReadiness: true,
      }),
    ).toMatchObject({
      agentSchemaMeta: {
        agentId: "alternate",
        role: "agent",
        schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
      },
    });
    expect(inspector.snapshotCount).toBe(0);
  });

  it("appends and hydrates plain transcript JSON and drains interleaved turns through the agent worker in FIFO order", async () => {
    const {
      upsertSessionEntryCore,
      appendTranscriptMessage,
      prepareSessionTranscriptHydration,
      openOpenClawAgentDatabase,
      openContextEngineTurnOutboxWorkerStore,
      drainContextEngineTurnOutbox,
    } = owners;
    const target = {
      agentId: "actor",
      sessionId: "postgres-transcript",
      sessionKey: "agent:actor:postgres-transcript",
      storePath: path.join(root, "agents", "actor", "sessions", "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const boundaries: TranscriptTurnBoundary[] = [];
    let parentId: string | undefined;
    for (const [index, key] of ["z-first", "a-second", "m-third"].entries()) {
      const user = await appendTranscriptMessage(target, {
        message: { role: "user", content: `${key} ${"λ🦞".repeat(1_000)}` },
        parentId,
        now: index * 3 + 1,
      });
      const intermediate =
        index === 0
          ? await appendTranscriptMessage(target, {
              message: { role: "assistant", content: `${key} progress` },
              parentId: user?.messageId,
              now: index * 3 + 2,
            })
          : undefined;
      const reply = await appendTranscriptMessage(target, {
        message: { role: "assistant", content: `${key} reply` },
        parentId: intermediate?.messageId ?? user?.messageId,
        now: index * 3 + 3,
      });
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
    expect(
      await owners.searchSessionTranscripts({ ...target, query: "progress", env: process.env }),
    ).toMatchObject({
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
    const database = withEngineStoreAdmission(() =>
      openOpenClawAgentDatabase({ agentId: "actor" }),
    );
    assert(isPostgresSqlConnection(database.db));
    const facts = getPostgresPhysicalFacts(database.db);
    assert(facts);
    {
      await using inspector = owners.createAgentSchemaInspectionWorker();
      expect(
        await inspector.inspect({
          pathname: database.path,
          agentId: "actor",
          env: process.env,
          supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
          verifyCurrentSchemaShape: true,
          inspectOwnership: true,
          requireStartupMigrationReadiness: true,
        }),
      ).toMatchObject({
        version: OPENCLAW_AGENT_SCHEMA_VERSION,
        agentSchemaMeta: {
          agentId: "actor",
          role: "agent",
          schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
      });
      expect(inspector.snapshotCount).toBe(0);
    }
    const payloads = await client.query<{ event_json: string; event_zstd: Buffer | null }>(
      `SELECT event_json, event_zstd FROM "${facts.namespace}".transcript_events ORDER BY seq`,
    );
    expect(payloads.rows).toHaveLength(hydrated.snapshot.events.length);
    expect(
      payloads.rows.every((row) => row.event_zstd === null && typeof row.event_json === "string"),
    ).toBe(true);
    expect(payloads.rows.map((row) => JSON.parse(row.event_json))).toEqual(
      hydrated.snapshot.events,
    );
    let store = openContextEngineTurnOutboxWorkerStore({ agentId: "actor", path: database.path });
    const filter = { engineId: "postgres-fixture", isHeartbeat: false };
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
    const queued = await client.query<{ advancement_key: string; enqueue_sequence: string }>(
      `SELECT advancement_key, enqueue_sequence FROM "${facts.namespace}".context_engine_turn_outbox ORDER BY enqueue_sequence`,
    );
    expect(queued.rows.map((row) => row.advancement_key)).toEqual([
      "z-first",
      "a-second",
      "m-third",
    ]);
    expect(queued.rows.map((row) => Number(row.enqueue_sequence))).toEqual([1, 2, 3]);
    withEngineStoreAdmission(() => owners.closeOpenClawAgentDatabaseByPath(database.path));
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
      (await client.query(`SELECT count(*) FROM "${facts.namespace}".context_engine_turn_outbox`))
        .rows,
    ).toEqual([{ count: "0" }]);
  });

  it("searches active branches through the worker with session and role filters and lifecycle deletion", async () => {
    const target = {
      agentId: "actor",
      sessionId: "search-branch",
      sessionKey: "agent:actor:search-branch",
      storePath: path.join(root, "agents", "actor", "sessions", "sessions.json"),
      env: process.env,
    };
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
    expect((await owners.searchSessionTranscripts({ ...search, role: "assistant" })).hits).toEqual([
      expect.objectContaining({ messageId: "search-assistant" }),
    ]);
    expect(
      (await owners.searchSessionTranscripts({ ...search, sessionId: sibling.sessionId })).hits,
    ).toEqual([expect.objectContaining({ messageId: "search-sibling-user" })]);
    expect(
      (await owners.searchSessionTranscripts({ ...search, sessionKeys: [target.sessionKey] })).hits
        .map((hit) => hit.messageId)
        .toSorted(),
    ).toEqual(["search-assistant", "search-user"]);
    await owners.appendTranscriptEvent(target, {
      type: "leaf",
      id: "search-leaf",
      parentId: "search-assistant",
      targetId: "search-user",
    });
    expect((await owners.searchSessionTranscripts({ ...search, query: "beta" })).hits).toEqual([]);
    const options = { agentId: target.agentId, env: process.env };
    await owners.waitForSessionTranscriptIndexReconcile(options);
    if ((await owners.searchSessionTranscripts(search)).indexing) {
      await owners.reconcileSessionTranscriptIndexes(options);
    }
    expect(await owners.searchSessionTranscripts({ ...search, query: "alpha" })).toMatchObject({
      hits: [expect.objectContaining({ messageId: "search-user" })],
      indexing: false,
    });
    expect((await owners.searchSessionTranscripts({ ...search, query: "beta" })).hits).toEqual([]);
    const removal = {
      ...target,
      target: { canonicalKey: target.sessionKey, storeKeys: [target.sessionKey] },
      archiveTranscript: false,
      deleteTranscriptWithoutArchive: true,
    };
    await owners.upsertSessionEntryCore(sibling, { previousSessionId: target.sessionId });
    expect(await owners.deleteSessionEntryLifecycle(removal)).toMatchObject({ deleted: true });
    expect((await owners.searchSessionTranscripts({ ...search, query: "alpha" })).hits).toEqual([
      expect.objectContaining({ sessionId: target.sessionId, messageId: "search-user" }),
    ]);
    await owners.upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 2 });
    await owners.upsertSessionEntryCore(sibling, { previousSessionId: undefined });
    expect(await owners.deleteSessionEntryLifecycle(removal)).toMatchObject({ deleted: true });
    expect((await owners.searchSessionTranscripts(search)).hits).toEqual([
      expect.objectContaining({ sessionId: sibling.sessionId, messageId: "search-sibling-user" }),
    ]);
  });

  it("indexes only accepted searchable messages from a transcript append batch", async () => {
    const target = {
      agentId: "actor",
      sessionId: "fts-append-batch",
      sessionKey: "agent:actor:fts-append-batch",
      storePath: path.join(root, "agents", "actor", "sessions", "sessions.json"),
      env: process.env,
    };
    await owners.upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const event = (id: string, parentId: string | null, role: string, content: string) => ({
      type: "message",
      id,
      parentId,
      timestamp: 1,
      message: { role, content },
    });
    withEngineStoreAdmission(() =>
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

  it.each([4, 67])(
    "preserves FTS row identity for %i nullable and repeated message IDs in bounded statements",
    async (count) => {
      const sessionId = `fts-identities-${count}`;
      const options = { agentId: "actor" };
      const database = withEngineStoreAdmission(() => owners.openOpenClawAgentDatabase(options));
      const postgres = database.db;
      assert(isPostgresSqlConnection(postgres));
      const facts = getPostgresPhysicalFacts(postgres);
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
      withEngineStoreAdmission(() =>
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
      const persisted = await client.query(
        `SELECT r.id, r.id = f.rowid AS same_id, r.message_id AS owner_message_id,
          f.message_id, f.text, f.role, f.timestamp
          FROM "${facts.namespace}".session_transcript_fts_rows r
          LEFT JOIN "${facts.namespace}".session_transcript_fts f ON f.rowid = r.id
          WHERE r.session_id = $1 ORDER BY f.timestamp`,
        [sessionId],
      );
      expect(persisted.rows).toHaveLength(count);
      expect(persisted.rows.map(({ id: _id, ...row }) => row)).toEqual(
        entries.map((entry) => ({
          same_id: true,
          owner_message_id: entry.messageId,
          message_id: entry.messageId,
          text: entry.text,
          role: entry.role,
          timestamp: entry.timestamp,
        })),
      );
      const ids = persisted.rows.map((row) => BigInt(row.id));
      for (let index = 1; index < ids.length; index++) {
        expect(ids[index]).toBeGreaterThan(ids[index - 1]!);
      }
      const exported = withEngineStoreAdmission(() =>
        Array.from(
          iterateSqliteQuerySync(
            database.db,
            owners.selectSessionTranscriptFtsRows(database.db, sessionId),
          ),
        ),
      );
      expect(exported).toEqual(
        entries.map((entry) => ({
          message_id: entry.messageId,
          text: entry.text,
          role: entry.role,
          timestamp: entry.timestamp,
        })),
      );
      for (const index of [0, 1, 2, 3]) {
        const searched = await client.query(
          `SELECT message_id, text FROM "${facts.namespace}".session_transcript_fts
            WHERE session_id = $1 AND openclaw_search @@
              plainto_tsquery('"${facts.namespace}".openclaw_simple_unaccent', $2)`,
          [sessionId, `ftskeytoken${index}`],
        );
        expect(searched.rows).toEqual([
          { message_id: index < 2 ? null : "repeated", text: `ftskeytoken${index}` },
        ]);
      }
      // Each observed PostgreSQL statement makes one bridge/server request.
      expect(statements).toBe(count === 4 ? 1 : 2);
      if (count > 64) {
        withEngineStoreAdmission(() => {
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
      withDatabaseEngineSelection(
        {
          effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine } }),
          postgres: { connection: connection!, schemaPrefix: prefix },
        },
        () =>
          withEngineStoreAdmission(() => {
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
            const database = owners.openOpenClawAgentDatabase(options);
            try {
              owners.runOpenClawAgentWriteTransaction((writer) => {
                expect(
                  owners.appendTranscriptEventsInTransaction(writer, target, events, {
                    scheduleProjectionReconcile: false,
                  }),
                ).toBe(events.length);
              }, options);
              const exported = Array.from(
                iterateSqliteQuerySync(
                  database.db,
                  owners.selectSessionTranscriptFtsRows(database.db, target.sessionId),
                ),
              );
              expect(exported.map((row) => row.message_id)).toEqual(
                events.map((event) => event.id),
              );
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
            } finally {
              owners.closeOpenClawAgentDatabaseByPath(database.path);
            }
          }),
      ),
    );
    expect(results[1]).toEqual(results[0]);
  });

  it("reads persisted auth through the selected owner and agent worker", async () => {
    const {
      openOpenClawAgentDatabase,
      runOpenClawAgentWriteTransaction,
      writeAuthProfileJsonCell,
      inspectPersistedAuthProfileStoreRaw,
      prepareAgentAuthProfileRowsRead,
    } = owners;
    const store = {
      version: 1,
      profiles: { fixture: { type: "api_key", provider: "fixture", key: "synthetic" } },
    };
    for (const options of [
      { agentId: "main" },
      { agentId: "alternate", path: path.join(root, "explicit", "openclaw-agent.sqlite") },
    ]) {
      const database = withEngineStoreAdmission(() => openOpenClawAgentDatabase(options));
      withEngineStoreAdmission(() =>
        runOpenClawAgentWriteTransaction(
          ({ db }) => writeAuthProfileJsonCell(db, "store", "agent", store),
          options,
        ),
      );
      expect(
        withEngineStoreAdmission(() =>
          inspectPersistedAuthProfileStoreRaw(path.dirname(database.path)),
        ),
      ).toEqual({
        status: "readable",
        raw: store,
      });
      withEngineStoreAdmission(() => owners.closeOpenClawAgentDatabaseByPath(database.path));
      await owners.closeOpenClawAgentDatabaseByPathAsync(database.path);
      const reader = prepareAgentAuthProfileRowsRead({
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
    retireSqliteDatabaseAdmissionForPath(sharedMainPath);
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
    const { openOpenClawAgentDatabase, closeOpenClawAgentDatabaseByPath } = owners;
    const agentId = change === "ownership" ? "wrong-owner" : "drift";
    const options = { agentId, path: path.join(root, agentId, "agent.sqlite") };
    const database = withEngineStoreAdmission(() => openOpenClawAgentDatabase(options));
    assert(isPostgresSqlConnection(database.db));
    const facts = getPostgresPhysicalFacts(database.db);
    assert(facts);
    withEngineStoreAdmission(() => closeOpenClawAgentDatabaseByPath(database.path));
    retireSqliteDatabaseAdmissionForPath(database.path);
    await client.query(
      change === "ownership"
        ? `UPDATE "${facts.namespace}".schema_meta SET agent_id = 'different'`
        : `ALTER TABLE "${facts.namespace}".cache_entries ADD COLUMN unexpected TEXT`,
    );
    expect(() => withEngineStoreAdmission(() => openOpenClawAgentDatabase(options))).toThrow(
      change === "ownership"
        ? /belongs to agent different; requested agent wrong-owner/
        : /schema drift/i,
    );
  });
});
