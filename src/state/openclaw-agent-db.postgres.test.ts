import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { TranscriptTurnBoundary } from "../config/sessions/transcript-entry-anchor.js";
import type { ContextEngine } from "../context-engine/types.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { installDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import type { SearchSchema } from "../infra/database-engine/contract.js";
import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import { retireSqliteDatabaseAdmissionForPath } from "../infra/sqlite-database-admission.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { readOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

async function loadOwners() {
  const [
    database,
    readonly,
    sessions,
    transcripts,
    hydration,
    outbox,
    drain,
    auth,
    authRead,
    authWrite,
    cleanup,
    search,
    inspection,
    authBootstrap,
    authOwnership,
    reconcile,
    lifecycle,
    engine,
    maintenance,
  ] = await Promise.all([
    import("./openclaw-agent-db.js"),
    import("./openclaw-agent-db-readonly.js"),
    import("../config/sessions/session-accessor.sqlite-entry.js"),
    import("../config/sessions/session-accessor.sqlite-transcript-write.js"),
    import("../config/sessions/session-transcript-hydration.js"),
    import("../agents/harness/context-engine-turn-outbox-store.js"),
    import("../agents/harness/context-engine-turn-outbox.js"),
    import("../agents/auth-profiles/sqlite.js"),
    import("../agents/auth-profiles/sqlite-read.js"),
    import("../agents/auth-profiles/sqlite-json-write.js"),
    import("../test-utils/session-state-cleanup.js"),
    import("../config/sessions/session-transcript-search.js"),
    import("./openclaw-agent-schema-inspection-worker.js"),
    import("../agents/auth-profiles/shared-store-bootstrap-async.js"),
    import("../agents/auth-profiles/path-resolve.js"),
    import("../config/sessions/session-transcript-reconcile.js"),
    import("../config/sessions/session-accessor.sqlite-lifecycle.js"),
    import("./openclaw-agent-db-engine.js"),
    import("./openclaw-agent-db-maintenance-lease.js"),
  ]);
  return {
    openOpenClawAgentDatabase: database.openOpenClawAgentDatabase,
    getOpenClawAgentDatabaseIfOpen: database.getOpenClawAgentDatabaseIfOpen,
    closeOpenClawAgentDatabaseByPath: database.closeOpenClawAgentDatabaseByPath,
    closeOpenClawAgentDatabaseByPathAsync: database.closeOpenClawAgentDatabaseByPathAsync,
    runOpenClawAgentWriteTransaction: database.runOpenClawAgentWriteTransaction,
    retainOpenClawAgentDatabaseReadOnly: readonly.retainOpenClawAgentDatabaseReadOnly,
    upsertSessionEntryCore: sessions.upsertSessionEntryCore,
    appendTranscriptMessage: transcripts.appendTranscriptMessage,
    appendTranscriptEvent: transcripts.appendTranscriptEvent,
    prepareSessionTranscriptHydration: hydration.prepareSessionTranscriptHydration,
    openContextEngineTurnOutboxWorkerStore: outbox.openContextEngineTurnOutboxWorkerStore,
    drainContextEngineTurnOutbox: drain.drainContextEngineTurnOutbox,
    inspectPersistedAuthProfileStoreRaw: auth.inspectPersistedAuthProfileStoreRaw,
    prepareAgentAuthProfileRowsRead: authRead.prepareAgentAuthProfileRowsRead,
    writeAuthProfileJsonCell: authWrite.writeAuthProfileJsonCell,
    cleanupSessionStateForTest: cleanup.cleanupSessionStateForTest,
    searchSessionTranscripts: search.searchSessionTranscripts,
    createAgentSchemaInspectionWorker: inspection.createAgentSchemaInspectionWorker,
    prepareFreshSharedAuthStoreWriteAsync: authBootstrap.prepareFreshSharedAuthStoreWriteAsync,
    resolveSharedAuthStoreOwnership: authOwnership.resolveSharedAuthStoreOwnership,
    waitForSessionTranscriptIndexReconcile: reconcile.waitForSessionTranscriptIndexReconcile,
    reconcileSessionTranscriptIndexes: reconcile.reconcileSessionTranscriptIndexes,
    deleteSessionEntryLifecycle: lifecycle.deleteSessionEntryLifecycle,
    admitAgentEngineSearchExtensions: engine.admitAgentEngineSearchExtensions,
    openAgentEngineStore: engine.openAgentEngineStore,
    withAgentDatabaseMaintenanceLease: maintenance.withAgentDatabaseMaintenanceLease,
  };
}

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
    const database = withEngineStoreAdmission(() => owners.openOpenClawAgentDatabase(options));
    try {
      assert(isPostgresSqlConnection(database.db));
      const facts = getPostgresPhysicalFacts(database.db);
      assert(facts);
      withEngineStoreAdmission(() =>
        owners.runOpenClawAgentWriteTransaction(({ db }) => {
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
        }, options),
      );
      withEngineStoreAdmission(() => {
        owners.admitAgentEngineSearchExtensions(
          database.db,
          { "memory.text": memorySearch },
          () => undefined,
        );
        assertMemorySearch(database.db);
      });
      await owners.upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      await owners.appendTranscriptMessage(target, {
        eventId: "migration-user",
        parentId: null,
        message: { role: "user", content: "migration searchable archive" },
      });
      await owners.appendTranscriptMessage(target, {
        eventId: "migration-reply",
        parentId: "migration-user",
        message: { role: "assistant", content: "migration retained reply" },
      });
      const retained = await client.query(
        `SELECT session_id, event_id, parent_id FROM "${facts.namespace}".transcript_event_identities ORDER BY seq`,
      );
      withEngineStoreAdmission(() => owners.closeOpenClawAgentDatabaseByPath(database.path));
      await owners.closeOpenClawAgentDatabaseByPathAsync(database.path);
      await owners.cleanupSessionStateForTest({ stateDir: root });
      retireSqliteDatabaseAdmissionForPath(database.path);
      // Restore the historical catalog under exclusive fixture custody, including an unsealed marker.
      await client.query(`BEGIN;
        SET LOCAL search_path TO "${facts.namespace}";
        ALTER FUNCTION openclaw_transcript_navigation_check(text)
          CALLED ON NULL INPUT RESET search_path;
        DROP INDEX idx_agent_session_windows_conversation;
        CREATE INDEX idx_agent_session_windows_conversation
          ON session_windows(primary_conversation_id ASC NULLS FIRST,
            updated_at DESC NULLS LAST, session_id ASC NULLS FIRST)
          WHERE primary_conversation_id IS NOT NULL;
        CREATE INDEX idx_agent_transcript_event_parent
          ON transcript_event_identities(session_id ASC NULLS FIRST, parent_id ASC NULLS FIRST)
          WHERE parent_id IS NOT NULL;
        CREATE INDEX idx_agent_session_nodes_last_interaction_at
          ON session_nodes(last_interaction_at DESC NULLS LAST, session_key ASC NULLS FIRST);
        CREATE INDEX idx_agent_session_reactions_message
          ON session_reactions(session_key ASC NULLS FIRST,
            session_id ASC NULLS FIRST, message_id ASC NULLS FIRST);
        UPDATE schema_meta SET schema_version = 27;
        UPDATE openclaw_schema_meta
          SET version = 27, fingerprint = NULL, ddl_hash = NULL, server_major = NULL;
        COMMIT;`);
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
              using anchor = openNodeSqliteDatabase(database.path);
              lease.assertOwned();
              withEngineStoreAdmission(() => {
                const engine = owners.openAgentEngineStore(
                  anchor,
                  target.agentId,
                  database.path,
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
      withEngineStoreAdmission(() => owners.closeOpenClawAgentDatabaseByPath(database.path));
      await owners.closeOpenClawAgentDatabaseByPathAsync(database.path);
      retireSqliteDatabaseAdmissionForPath(database.path);
      const reopened = withEngineStoreAdmission(() => owners.openOpenClawAgentDatabase(options));
      expect(getPostgresPhysicalFacts(reopened.db)?.version).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
      withEngineStoreAdmission(() => assertMemorySearch(reopened.db));
    } finally {
      withEngineStoreAdmission(() => owners.closeOpenClawAgentDatabaseByPath(database.path));
      await owners.closeOpenClawAgentDatabaseByPathAsync(database.path);
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
