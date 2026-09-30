import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import * as coldStorageCodec from "../config/sessions/session-cold-storage-codec.js";
import { readSessionColdTranscript } from "../config/sessions/session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import type { AssistantMessage } from "../llm/types.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import { readSessionCostUsageRollupRows } from "./session-cost-usage-cache.test-support.js";
import { resolveUsageCostPricingFingerprint } from "./session-cost-usage-pricing-context.js";
import { prepareUsageCostWorker } from "./session-cost-usage-worker-runtime.js";
import { executeUsageCostWorker } from "./session-cost-usage-worker.js";
import { discoverAllSessions } from "./session-cost-usage.js";

const archiveTime = Date.UTC(2026, 7, 26, 12);
const config = { plugins: { enabled: false } };

function assistant(tokens: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: `answer with ${tokens} tokens` }],
    api: "openai-responses",
    provider: "fixture",
    model: "usage-fixture",
    stopReason: "stop",
    timestamp: archiveTime,
    usage: {
      input: tokens - 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: tokens,
      cost: {
        input: (tokens - 1) / 1000,
        output: 0.001,
        cacheRead: 0,
        cacheWrite: 0,
        total: tokens / 1000,
      },
    },
  };
}

describe("usage cold cache", () => {
  let state: OpenClawTestState;

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "usage-cold-cache" });
    await state.writeConfig(config);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await state.cleanup();
  });

  it("uses fresh rollups before cold archive event-time scans and falls back when stale or new", async () => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const coldConfig = {
      ...config,
      agents: { list: [{ id: "main" }] },
      session: {
        store: storePath,
        maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
      },
    };
    const ageTranscript = async (scope: {
      agentId: string;
      sessionId: string;
      sessionKey: string;
      storePath: string;
    }) => {
      await replaceSessionEntry(scope, {
        ...expectDefined(loadSessionEntry(scope), "cached cold usage fixture"),
        updatedAt: 1,
        lastActivityAt: 1,
        lastInteractionAt: 1,
      });
      runOpenClawAgentWriteTransaction(
        ({ db }) => {
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<DB>(db)
              .updateTable("session_windows")
              .set({ updated_at: 1, transcript_updated_at: 1 })
              .where("session_id", "=", scope.sessionId),
          );
        },
        { agentId: scope.agentId, env: state.env },
      );
    };
    const addSession = async (sessionId: string, timestamp: number) => {
      const scope = {
        agentId: "main",
        sessionId,
        sessionKey: "agent:main:" + sessionId,
        storePath,
      };
      await upsertSessionEntryCore(scope, { sessionId, updatedAt: archiveTime });
      await persistSessionTranscriptTurn(scope, {
        messages: [{ message: { ...assistant(3), timestamp } }],
        touchSessionEntry: false,
      });
      await ageTranscript(scope);
      return scope;
    };

    const cachedScopes = [];
    for (let index = 0; index < 8; index++) {
      cachedScopes.push(await addSession("cached-cold-" + index, archiveTime));
    }
    await expect(
      refreshCostUsageCacheForAgent({ agentId: "main", config: coldConfig, startMs: 0 }),
    ).resolves.toBe("refreshed");
    expect(readSessionCostUsageRollupRows("main")).toHaveLength(cachedScopes.length);
    await expect(runSessionColdStorageMaintenance({ config: coldConfig })).resolves.toMatchObject({
      archivedTranscripts: cachedScopes.length,
    });
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    for (const scope of cachedScopes) {
      expect(readSessionColdTranscript(database.db, scope.sessionId)).toBeDefined();
    }

    const prepared = prepareUsageCostWorker({
      agentId: "main",
      config: coldConfig,
      env: state.env,
    });
    const pricingFingerprint = await resolveUsageCostPricingFingerprint(
      coldConfig,
      state.agentDir(),
    );
    const now = Date.now();
    const input = {
      kind: "usage-cost" as const,
      location: prepared.location,
      databases: prepared.databases.map(({ agentId, path: databasePath }) => ({
        agentId,
        path: databasePath,
      })),
      operation: {
        kind: "summary" as const,
        pricingFingerprint,
        startMs: now - 7 * 86_400_000,
        endMs: now,
        dayBucket: { mode: "utc-offset" as const, utcOffsetMinutes: 0 },
      },
    };
    const channel = {
      consumeInput() {},
      async request() {
        throw new Error("unexpected usage worker host effect");
      },
    };
    const control = {
      throwIfCancelled() {},
      async runNativeSection<T>(operation: () => T | Promise<T>): Promise<T> {
        return await operation();
      },
    };
    const readDatabase = async <T>(
      _database: { agentId: string; path: string },
      read: () => T | Promise<T>,
    ) => await read();
    const runSummary = () => executeUsageCostWorker(input, channel, control, readDatabase);
    const archiveReader = vi.spyOn(coldStorageCodec, "forEachVerifiedSessionColdArchiveEvent");

    await expect(runSummary()).resolves.toMatchObject({ kind: "summary" });
    expect(archiveReader).not.toHaveBeenCalled();
    await expect(runSummary()).resolves.toMatchObject({ kind: "summary" });
    expect(archiveReader).not.toHaveBeenCalled();

    const staleScope = expectDefined(cachedScopes[0], "cached cold archive fixture");
    runOpenClawAgentWriteTransaction(
      ({ db }) => {
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<DB>(db)
            .updateTable("session_windows")
            .set({ transcript_updated_at: 2 })
            .where("session_id", "=", staleScope.sessionId),
        );
      },
      { agentId: "main", env: state.env },
    );
    await runSummary();
    expect(
      archiveReader.mock.calls.some(
        ([params]) => params.archive.session_id === staleScope.sessionId,
      ),
    ).toBe(true);

    const recentScope = await addSession("new-cold-recent-event", now);
    await expect(runSessionColdStorageMaintenance({ config: coldConfig })).resolves.toMatchObject({
      archivedTranscripts: 1,
    });
    // Legacy inventory uses window metadata, not the recent event time in this cold archive.
    runOpenClawAgentWriteTransaction(
      ({ db }) => {
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<DB>(db)
            .updateTable("session_windows")
            .set({ updated_at: 1, transcript_updated_at: 1 })
            .where("session_id", "=", recentScope.sessionId),
        );
      },
      { agentId: "main", env: state.env },
    );
    expect(
      (await discoverAllSessions({ agentId: "main", startMs: now - 7 * 86_400_000 })).some(
        (session) => session.sessionId === recentScope.sessionId,
      ),
    ).toBe(false);
    archiveReader.mockClear();
    await runSummary();
    expect(
      archiveReader.mock.calls.some(
        ([params]) => params.archive.session_id === recentScope.sessionId,
      ),
    ).toBe(true);
  });

  it("reuses verified bounded cold-archive exclusions and invalidates replacements", async () => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const coldConfig = {
      ...config,
      agents: { list: [{ id: "main" }] },
      session: {
        store: storePath,
        maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
      },
    };
    const scope = {
      agentId: "main",
      sessionId: "unrolled-cold-session",
      sessionKey: "agent:main:unrolled-cold-session",
      storePath,
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: archiveTime });
    await persistSessionTranscriptTurn(scope, {
      messages: [{ message: { ...assistant(3), timestamp: archiveTime } }],
      touchSessionEntry: false,
    });
    const ageTranscript = async () => {
      await replaceSessionEntry(scope, {
        ...expectDefined(loadSessionEntry(scope), "uncached cold usage fixture"),
        updatedAt: 1,
        lastActivityAt: 1,
        lastInteractionAt: 1,
      });
      runOpenClawAgentWriteTransaction(
        ({ db }) => {
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<DB>(db)
              .updateTable("session_windows")
              .set({ updated_at: 1, transcript_updated_at: 1 })
              .where("session_id", "=", scope.sessionId),
          );
        },
        { agentId: "main", env: state.env },
      );
    };
    await ageTranscript();
    await expect(runSessionColdStorageMaintenance({ config: coldConfig })).resolves.toMatchObject({
      archivedTranscripts: 1,
    });
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const originalArchive = expectDefined(
      readSessionColdTranscript(database.db, scope.sessionId),
      "original cold archive metadata",
    );

    const prepared = prepareUsageCostWorker({
      agentId: "main",
      config: coldConfig,
      env: state.env,
    });
    const pricingFingerprint = await resolveUsageCostPricingFingerprint(
      coldConfig,
      state.agentDir(),
    );
    const now = Date.now();
    const input = {
      kind: "usage-cost" as const,
      location: prepared.location,
      databases: prepared.databases.map(({ agentId, path: databasePath }) => ({
        agentId,
        path: databasePath,
      })),
      operation: {
        kind: "summary" as const,
        pricingFingerprint,
        startMs: now - 7 * 86_400_000,
        endMs: now,
        dayBucket: { mode: "utc-offset" as const, utcOffsetMinutes: 0 },
      },
    };
    const channel = {
      consumeInput() {},
      async request() {
        throw new Error("unexpected usage worker host effect");
      },
    };
    const control = {
      throwIfCancelled() {},
      async runNativeSection<T>(operation: () => T | Promise<T>): Promise<T> {
        return await operation();
      },
    };
    const readDatabase = async <T>(
      _database: { agentId: string; path: string },
      read: () => T | Promise<T>,
    ) => await read();
    const runSummary = () => executeUsageCostWorker(input, channel, control, readDatabase);
    const archiveReader = vi.spyOn(coldStorageCodec, "forEachVerifiedSessionColdArchiveEvent");

    expect(readSessionCostUsageRollupRows("main")).toHaveLength(0);
    const first = await runSummary();
    expect(first).toMatchObject({ kind: "summary" });
    expect(
      archiveReader.mock.calls.some(([params]) => params.archive.session_id === scope.sessionId),
    ).toBe(true);
    archiveReader.mockClear();
    await expect(runSummary()).resolves.toMatchObject({ kind: "summary" });
    expect(archiveReader).not.toHaveBeenCalled();

    const replacementGeneration = `replacement-${originalArchive.generation}`;
    runOpenClawAgentWriteTransaction(
      ({ db }) => {
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<DB>(db)
            .updateTable("session_transcript_cold_archives")
            .set({ generation: replacementGeneration })
            .where("session_id", "=", scope.sessionId),
        );
      },
      { agentId: "main", env: state.env },
    );
    archiveReader.mockClear();
    await expect(runSummary()).rejects.toThrow(/metadata does not match its contents/i);
    expect(
      archiveReader.mock.calls.some(([params]) => params.archive.session_id === scope.sessionId),
    ).toBe(true);
  });
});
