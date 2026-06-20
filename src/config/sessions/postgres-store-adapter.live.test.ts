import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresSessionAdmissionController } from "./postgres-admission.js";
import {
  readLivePostgresSessionStoreTestConfig,
  type LivePostgresSessionStoreTestConfig,
} from "./postgres-live-integration-gate.js";
import {
  buildOpenClawSessionPostgresSchemaSql,
  qualifyPostgresSessionTable,
} from "./postgres-schema.js";
import {
  createPostgresSessionStoreAdapter,
  type PostgresSessionStoreQueryClient,
  type PostgresSessionStoreQueryResult,
  type PostgresSessionStoreQueryRow,
} from "./postgres-store-adapter.js";
import { migrateTranscriptJsonlSessionTurnsToAdapter } from "./session-turn-migration.js";
import type { SessionStoreAdapter, SessionStoreRecord } from "./storage-adapter.js";
import {
  createSyntheticSessionStore,
  runBoundedSessionStoreReadBenchmark,
  syntheticSessionStoreKey,
} from "./store-benchmark.js";
import {
  migrateSessionStoreAdapter,
  migrateSessionStoreAdapterInBatches,
  planSessionStoreAdapterMigration,
} from "./store-migration.js";
import { migrateTranscriptJsonlToAdapter } from "./transcript-chunk-migration.js";

type PgClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: PostgresSessionStoreQueryRow[]; rowCount?: number | null }>;
};

type PgModule = {
  Client: new (options: { connectionString: string }) => PgClient;
};

const liveConfig = readLivePostgresSessionStoreTestConfig();
const require = createRequire(import.meta.url);

function requirePgClientConstructor(): PgModule["Client"] {
  try {
    return (require("pg") as PgModule).Client;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `OPENCLAW_SESSION_STORE_LIVE_POSTGRES=1 requires optional package "pg" in the test environment: ${detail}`,
      { cause: error },
    );
  }
}

function createPostgresQueryClient(client: PgClient): PostgresSessionStoreQueryClient {
  return {
    async query<TRow extends PostgresSessionStoreQueryRow = PostgresSessionStoreQueryRow>(
      sql: string,
      values?: readonly unknown[],
    ): Promise<PostgresSessionStoreQueryResult<TRow>> {
      const result = await client.query(sql, values);
      return {
        rows: result.rows as TRow[],
        rowCount: result.rowCount,
      };
    },
  };
}

function createMemoryAdapter(initial: SessionStoreRecord): SessionStoreAdapter {
  let store = structuredClone(initial) as SessionStoreRecord;
  return {
    kind: "memory",
    async loadStore() {
      return structuredClone(store) as SessionStoreRecord;
    },
    async readEntry(_storePath, sessionKey) {
      return structuredClone(store[sessionKey]);
    },
    async listEntries(_storePath, options) {
      const sorted = Object.entries(store).toSorted(([left], [right]) => left.localeCompare(right));
      const offset = options?.offset ?? 0;
      const entries =
        options?.limit === undefined
          ? sorted.slice(offset)
          : sorted.slice(offset, offset + options.limit);
      const nextOffset =
        options?.limit !== undefined && offset + options.limit < sorted.length
          ? offset + options.limit
          : undefined;
      return {
        entries,
        totalCount: sorted.length,
        ...(options?.limit !== undefined ? { limitApplied: options.limit } : {}),
        ...(offset > 0 ? { offset } : {}),
        ...(nextOffset !== undefined ? { nextOffset } : {}),
        hasMore: nextOffset !== undefined,
      };
    },
    async saveStore(_storePath, nextStore) {
      store = structuredClone(nextStore) as SessionStoreRecord;
    },
    async updateStore<T>(
      _storePath: string,
      mutator: (store: SessionStoreRecord) => T | Promise<T>,
    ) {
      const nextStore = structuredClone(store) as SessionStoreRecord;
      const result = await mutator(nextStore);
      store = nextStore;
      return result;
    },
  };
}

describe.skipIf(!liveConfig.enabled)("Postgres session store adapter live integration", () => {
  let pgClient: PgClient | undefined;
  let queryClient: PostgresSessionStoreQueryClient | undefined;
  let config: Extract<LivePostgresSessionStoreTestConfig, { enabled: true }> | undefined;

  beforeAll(async () => {
    if (!liveConfig.enabled) {
      return;
    }
    config = liveConfig;
    const Client = requirePgClientConstructor();
    pgClient = new Client({ connectionString: config.connectionString });
    await pgClient.connect();
    queryClient = createPostgresQueryClient(pgClient);
    await queryClient.query(`SET statement_timeout = ${config.statementTimeoutMs}`);
    await queryClient.query(buildOpenClawSessionPostgresSchemaSql(config.schema));
  });

  afterAll(async () => {
    await pgClient?.end();
  });

  it("round-trips session store data, migration, isolation, and bounded reads", async () => {
    expect(config).toBeDefined();
    expect(queryClient).toBeDefined();
    const activeConfig = config!;
    const adapter = createPostgresSessionStoreAdapter(queryClient!, {
      tenantId: `${activeConfig.tenantId}-live-${Date.now()}`,
      gatewayId: `${activeConfig.gatewayId}-adapter`,
      schema: activeConfig.schema,
    });
    const storePath = `/nonlive/postgres/${Date.now()}/sessions.json`;

    await adapter.saveStore(storePath, {
      "agent:main:one": { sessionId: "session-one", updatedAt: 1 },
      "agent:main:two": { sessionId: "session-two", updatedAt: 2 },
    });

    await expect(adapter.readEntry(storePath, "agent:main:one")).resolves.toMatchObject({
      sessionId: "session-one",
      updatedAt: 1,
    });
    await expect(
      adapter.listEntries(storePath, { limit: 1, orderBy: "updatedAt_desc" }),
    ).resolves.toMatchObject({
      entries: [["agent:main:two", expect.objectContaining({ sessionId: "session-two" })]],
      totalCount: 2,
      limitApplied: 1,
      hasMore: true,
      nextOffset: 1,
    });

    await adapter.writeTranscriptChunks?.(
      storePath,
      "agent:main:one",
      [
        {
          chunkSeq: 0,
          transcriptPath: `${storePath}.session-one.jsonl`,
          contentSha256: "live-test-chunk",
          bytes: 12,
          chunkJson: { version: 1, startLine: 1, endLine: 1, lines: [{ type: "session" }] },
        },
      ],
      { agentId: "main" },
    );
    await expect(
      adapter.listTranscriptChunks?.(storePath, "agent:main:one", { limit: 1 }),
    ).resolves.toMatchObject({
      chunks: [
        expect.objectContaining({
          chunkSeq: 0,
          contentSha256: "live-test-chunk",
          bytes: 12,
        }),
      ],
      totalCount: 1,
      limitApplied: 1,
      hasMore: false,
    });

    expect(adapter.writeEntries).toBeDefined();
    expect(adapter.deleteEntries).toBeDefined();
    await adapter.writeEntries?.(storePath, [
      ["agent:main:batch", { sessionId: "session-batch", updatedAt: 4 }],
    ]);
    await expect(adapter.readEntry(storePath, "agent:main:batch")).resolves.toMatchObject({
      sessionId: "session-batch",
      updatedAt: 4,
    });
    await adapter.deleteEntries?.(storePath, ["agent:main:batch"]);
    await expect(adapter.readEntry(storePath, "agent:main:batch")).resolves.toBeUndefined();

    expect(adapter.writeSessionTurns).toBeDefined();
    expect(adapter.listSessionTurns).toBeDefined();
    await adapter.writeSessionTurns?.(
      storePath,
      "agent:main:one",
      [
        {
          turnSeq: 0,
          role: "user",
          modelProvider: "test-provider",
          model: "test-model",
          inputTokens: 3,
          startedAt: "2026-05-26T15:00:00.000Z",
          metadataJson: { source: "live-postgres-integration" },
        },
        {
          turnSeq: 1,
          role: "assistant",
          modelProvider: "test-provider",
          model: "test-model",
          inputTokens: 5,
          outputTokens: 8,
          startedAt: "2026-05-26T15:00:01.000Z",
          endedAt: "2026-05-26T15:00:02.000Z",
          metadataJson: { finishReason: "stop" },
        },
      ],
      { agentId: "main" },
    );
    await expect(
      adapter.listSessionTurns?.(storePath, "agent:main:one", {
        limit: 1,
        orderBy: "turnSeq_desc",
      }),
    ).resolves.toMatchObject({
      turns: [
        expect.objectContaining({
          turnSeq: 1,
          role: "assistant",
          modelProvider: "test-provider",
          model: "test-model",
          inputTokens: 5,
          outputTokens: 8,
        }),
      ],
      totalCount: 2,
      limitApplied: 1,
      nextOffset: 1,
      hasMore: true,
    });

    await adapter.updateStore(storePath, (store) => {
      store["agent:main:three"] = { sessionId: "session-three", updatedAt: 3 };
    });
    await expect(adapter.loadStore(storePath)).resolves.toMatchObject({
      "agent:main:three": { sessionId: "session-three", updatedAt: 3 },
    });

    const migrationSource = createMemoryAdapter({
      "agent:main:migrated": { sessionId: "session-migrated", updatedAt: 10 },
    });
    const migrationPath = `${storePath}:migration`;
    await expect(
      planSessionStoreAdapterMigration({
        sourceAdapter: migrationSource,
        destinationAdapter: adapter,
        sourceStorePath: "/fixture/sessions.json",
        destinationStorePath: migrationPath,
      }),
    ).resolves.toMatchObject({
      sourceEntryCount: 1,
      destinationEntryCountBefore: 0,
    });
    await expect(
      migrateSessionStoreAdapter({
        sourceAdapter: migrationSource,
        destinationAdapter: adapter,
        sourceStorePath: "/fixture/sessions.json",
        destinationStorePath: migrationPath,
        mode: "apply",
      }),
    ).resolves.toMatchObject({ applied: true, verified: true });
  });

  it("migrates JSON, transcript chunks, and derived turns into Postgres with rollback/read-back verification", async () => {
    expect(config).toBeDefined();
    expect(queryClient).toBeDefined();
    const activeConfig = config!;
    const adapter = createPostgresSessionStoreAdapter(queryClient!, {
      tenantId: `${activeConfig.tenantId}-migration-${Date.now()}`,
      gatewayId: `${activeConfig.gatewayId}-migration`,
      schema: activeConfig.schema,
    });
    const storePath = `/nonlive/postgres/migration/${Date.now()}/sessions.json`;
    const transcriptSessionKey = "agent:main:transcript";
    await adapter.saveStore(storePath, {
      [transcriptSessionKey]: { sessionId: "session-transcript", updatedAt: 20 },
    });

    const chunkedSource = createMemoryAdapter({
      "agent:main:chunk-a": { sessionId: "session-chunk-a", updatedAt: 30 },
      "agent:main:chunk-b": { sessionId: "session-chunk-b", updatedAt: 31 },
    });
    await expect(
      migrateSessionStoreAdapterInBatches({
        sourceAdapter: chunkedSource,
        destinationAdapter: adapter,
        sourceStorePath: "/fixture/chunked-sessions.json",
        destinationStorePath: `${storePath}:chunked`,
        mode: "apply",
        batchSize: 1,
      }),
    ).resolves.toMatchObject({
      applied: true,
      verified: true,
      batchesApplied: 2,
      entriesWritten: 2,
      checkpoint: { completed: true },
      malformedEntries: [],
    });

    const rollbackSource = createMemoryAdapter({
      "agent:main:rollback-a": { sessionId: "session-rollback-a", updatedAt: 40 },
      "agent:main:rollback-z": { updatedAt: 41 } as never,
    });
    const rollbackPath = `${storePath}:rollback`;
    await expect(
      migrateSessionStoreAdapterInBatches({
        sourceAdapter: rollbackSource,
        destinationAdapter: adapter,
        sourceStorePath: "/fixture/rollback-sessions.json",
        destinationStorePath: rollbackPath,
        mode: "apply",
        batchSize: 1,
      }),
    ).rejects.toMatchObject({
      name: "SessionStoreAdapterMigrationError",
      rolledBack: true,
    });
    await expect(adapter.loadStore(rollbackPath)).resolves.toEqual({});

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pg-transcript-"));
    try {
      const transcriptPath = path.join(tempDir, "session.jsonl");
      await fs.writeFile(
        transcriptPath,
        [
          JSON.stringify({ type: "session", id: "session-transcript" }),
          JSON.stringify({ type: "model_change", provider: "mxapi", modelId: "MiniMax-M2.7" }),
          JSON.stringify({ type: "message", id: "u1", message: { role: "user" } }),
          JSON.stringify({
            type: "message",
            id: "a1",
            message: { role: "assistant", usage: { outputTokens: 8 } },
          }),
          JSON.stringify({
            type: "message",
            id: "u2",
            message: { role: "user", usage: { inputTokens: 3 } },
          }),
          "",
        ].join("\n"),
        "utf8",
      );

      await expect(
        migrateTranscriptJsonlToAdapter({
          destinationAdapter: adapter,
          storePath,
          sessionKey: transcriptSessionKey,
          transcriptPath,
          mode: "apply",
          batchSize: 1,
          maxLinesPerChunk: 2,
          agentId: "main",
        }),
      ).resolves.toMatchObject({
        applied: true,
        verified: true,
        plan: { chunkCount: 3, malformedLines: [] },
        checkpoint: { chunksWritten: 3, completed: true },
        verification: { requested: true, ok: true, chunksExpected: 3, chunksRead: 3 },
      });

      await expect(
        migrateTranscriptJsonlSessionTurnsToAdapter({
          destinationAdapter: adapter,
          storePath,
          sessionKey: transcriptSessionKey,
          transcriptPath,
          mode: "apply",
          batchSize: 2,
          maxLinesPerChunk: 2,
          agentId: "main",
        }),
      ).resolves.toMatchObject({
        applied: true,
        verified: true,
        plan: { turnCount: 3, skippedLines: [] },
        checkpoint: { turnsWritten: 3, completed: true },
        verification: { requested: true, ok: true, turnsExpected: 3, turnsRead: 3 },
      });

      await expect(
        adapter.listTranscriptChunks?.(storePath, transcriptSessionKey, {
          limit: 2,
          transcriptPath,
        }),
      ).resolves.toMatchObject({
        totalCount: 3,
        limitApplied: 2,
        nextOffset: 2,
        hasMore: true,
      });
      await expect(
        adapter.listSessionTurns?.(storePath, transcriptSessionKey, {
          limit: 2,
          orderBy: "turnSeq_asc",
        }),
      ).resolves.toMatchObject({
        turns: [
          expect.objectContaining({ turnSeq: 0, role: "user", modelProvider: "mxapi" }),
          expect.objectContaining({
            turnSeq: 1,
            role: "assistant",
            model: "MiniMax-M2.7",
            outputTokens: 8,
          }),
        ],
        totalCount: 3,
        limitApplied: 2,
        nextOffset: 2,
        hasMore: true,
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("enforces leases, lane backpressure, and gateway health in Postgres", async () => {
    expect(config).toBeDefined();
    expect(queryClient).toBeDefined();
    const activeConfig = config!;
    const tenantId = `${activeConfig.tenantId}-admission-${Date.now()}`;
    const gatewayId = `${activeConfig.gatewayId}-admission`;
    const controller = createPostgresSessionAdmissionController(queryClient!, {
      tenantId,
      gatewayId,
      schema: activeConfig.schema,
    });

    await expect(
      controller.tryAcquireLease({
        leaseKey: "type0:publisher",
        holderId: "publisher-a",
        ttlMs: 60_000,
        metadata: { lane: "publisher" },
      }),
    ).resolves.toMatchObject({
      acquired: true,
      leaseKey: "type0:publisher",
      holderId: "publisher-a",
      expiresAt: expect.any(String),
    });
    await expect(
      controller.tryAcquireLease({
        leaseKey: "type0:publisher",
        holderId: "publisher-b",
        ttlMs: 60_000,
      }),
    ).resolves.toMatchObject({
      acquired: false,
      reason: "held",
      holderId: "publisher-a",
      expiresAt: expect.any(String),
    });
    await expect(
      controller.releaseLease({ leaseKey: "type0:publisher", holderId: "publisher-b" }),
    ).resolves.toBe(false);
    await expect(
      controller.releaseLease({ leaseKey: "type0:publisher", holderId: "publisher-a" }),
    ).resolves.toBe(true);

    await expect(
      controller.admitLane({ lane: "type0-publisher", maxRunning: 1, runningCost: 1 }),
    ).resolves.toMatchObject({
      admitted: true,
      snapshot: { lane: "type0-publisher", admitted: 1, running: 1, rejected: 0 },
    });
    await expect(
      controller.admitLane({ lane: "type0-publisher", maxRunning: 1, runningCost: 1 }),
    ).resolves.toMatchObject({
      admitted: false,
      reason: "max_running",
      snapshot: { lane: "type0-publisher", admitted: 1, running: 1, rejected: 1 },
    });
    await expect(
      controller.releaseLaneRun({ lane: "type0-publisher", runningCost: 1 }),
    ).resolves.toMatchObject({ lane: "type0-publisher", running: 0, rejected: 1 });

    await controller.recordGatewayHealth({
      processId: 4242,
      eventLoopLagMs: 37,
      configPath: "/nonlive/config.json",
      stateDir: "/nonlive/state",
      sessionDir: "/nonlive/sessions",
    });
    const gatewaysTable = qualifyPostgresSessionTable(
      "openclaw_session_gateways",
      activeConfig.schema,
    );
    await expect(
      queryClient!.query(
        `SELECT process_id, event_loop_lag_ms, config_path, state_dir, session_dir
         FROM ${gatewaysTable}
         WHERE tenant_id = $1 AND gateway_id = $2`,
        [tenantId, gatewayId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          process_id: 4242,
          event_loop_lag_ms: 37,
          config_path: "/nonlive/config.json",
          state_dir: "/nonlive/state",
          session_dir: "/nonlive/sessions",
        },
      ],
    });
  });

  it.skipIf(liveConfig.enabled && !liveConfig.runBenchmark)(
    "runs a gated 1k/10k bounded benchmark against the dedicated non-live DB",
    async () => {
      expect(config).toBeDefined();
      expect(queryClient).toBeDefined();
      const activeConfig = config!;
      const adapter = createPostgresSessionStoreAdapter(queryClient!, {
        tenantId: `${activeConfig.tenantId}-bench-${Date.now()}`,
        gatewayId: `${activeConfig.gatewayId}-benchmark`,
        schema: activeConfig.schema,
      });

      for (const sessionCount of [1_000, 10_000]) {
        const storePath = `/nonlive/postgres/benchmark/${Date.now()}/${sessionCount}.json`;
        await adapter.saveStore(storePath, createSyntheticSessionStore({ sessionCount }));
        await expect(
          runBoundedSessionStoreReadBenchmark(adapter, {
            storePath,
            pageSize: 100,
            expectedTotalCount: sessionCount,
            readKeys: [
              syntheticSessionStoreKey(0),
              syntheticSessionStoreKey(sessionCount - 1),
              "agent:main:missing",
            ],
          }),
        ).resolves.toMatchObject({
          pageSize: 100,
          entriesRead: sessionCount,
          totalCount: sessionCount,
          maxPageEntries: 100,
          readHits: 2,
          readMisses: 1,
        });
      }
    },
  );
});
