import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { encodeSessionArchiveContent } from "../config/sessions/archive-compression.js";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
} from "../config/sessions/legacy-sqlite-marker.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { resolveSessionColdArchivePath } from "../config/sessions/session-cold-storage-codec.js";
import { readSessionColdTranscript } from "../config/sessions/session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import type { AssistantMessage } from "../llm/types.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { racePromiseWithAbortSignal } from "./abort-signal.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import { readSessionCostUsageRollupRows } from "./session-cost-usage-cache.test-support.js";
import {
  listUsageCountedTranscriptStats,
  resolveUsageCostTranscriptFile,
} from "./session-cost-usage-collection.js";
import { resolveUsageCostPricingFingerprint } from "./session-cost-usage-pricing-context.js";
import { decodeUsageCostRollupEnvelope } from "./session-cost-usage-rollup-codec.js";
import {
  discoverAllSessions,
  loadCostUsageSummary,
  loadCostUsageSummaryFromCache,
  loadSessionCostSummariesFromCache,
  loadSessionCostSummary,
  loadSessionLogs,
  loadSessionUsageTimeSeries,
  resolveUsageSessionSource,
} from "./session-cost-usage.js";

const totalUsage = (agentId: string, scopedConfig = config) =>
  loadCostUsageSummary({
    agentId,
    config: scopedConfig,
    startMs: 0,
    endMs: Date.now() + 86_400_000,
  });

const archiveTime = Date.UTC(2026, 7, 26, 12);
const archiveStamp = "2026-08-26T12-00-00.000Z";
const generation = "0123456789abcdef0123456789abcdef";
const config = { plugins: { enabled: false } };
type Encoding = "plain" | "zstd";

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

function transcript(tokens = 17): SessionManager {
  const manager = SessionManager.inMemory();
  manager.appendMessage({
    role: "user",
    content: "retained archive prompt",
    timestamp: archiveTime,
  });
  manager.appendMessage(assistant(tokens));
  return manager;
}

function serialize(manager: SessionManager): string {
  return (
    [manager.getHeader(), ...manager.getEntries()]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n"
  );
}

async function writeArchive(params: {
  state: OpenClawTestState;
  manager: SessionManager;
  encoding: Encoding;
  reason?: "reset" | "deleted";
  agentId?: string;
  mtime?: number;
  generated?: boolean;
}): Promise<string> {
  const content = serialize(params.manager);
  const encoded =
    params.encoding === "zstd"
      ? encodeSessionArchiveContent(content)
      : { bytes: Buffer.from(content), suffix: "" };
  const directory = params.state.sessionsDir(params.agentId);
  await fs.mkdir(directory, { recursive: true });
  const fileName = `${params.manager.getSessionId()}.jsonl.${params.reason ?? "reset"}.${archiveStamp}${params.generated ? `.${generation}` : ""}${encoded.suffix}`;
  const filePath = path.join(directory, fileName);
  await fs.writeFile(filePath, encoded.bytes);
  const mtime = new Date(params.mtime ?? archiveTime);
  await fs.utimes(filePath, mtime, mtime);
  return filePath;
}

async function cachedTotal(agentId: string) {
  return await loadCostUsageSummaryFromCache({
    agentId,
    config,
    startMs: 0,
    endMs: Date.now() + 86_400_000,
    requestRefresh: false,
  });
}

describe("usage archive identity", () => {
  let state: OpenClawTestState;

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "usage-archive-identity" });
    await state.writeConfig(config);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await state.cleanup();
  });

  it("uses explicit usage artifacts and validates canonical targets in the worker", async () => {
    const root = state.statePath();
    const sessionsDir = state.sessionsDir();
    const sessionId = "session";
    const storePath = path.join(root, "sessions.json");
    const marker = `sqlite:main:${sessionId}:${storePath}`;
    const stale = `sqlite:main:stale:${storePath}`;
    const foreign = `sqlite:other:${sessionId}:${storePath}`;
    const artifact = path.join(root, `${sessionId}.jsonl`);
    const resolve = async (
      params: Omit<Parameters<typeof resolveUsageSessionSource>[0], "agentId"> & {
        agentId?: string;
      },
    ) => (await resolveUsageSessionSource({ agentId: "main", sessionId, ...params }))?.sessionFile;
    await fs.writeFile(artifact, "explicit artifact");
    const historicalInput = {
      sessionEntry: { sessionFile: marker, sessionId, updatedAt: 1 },
      sessionFile: artifact,
    };
    expect(await resolve(historicalInput)).toBe(artifact);
    expect(await resolve({ ...historicalInput, sessionFile: foreign })).toBeUndefined();
    expect(await resolve({ sessionFile: stale })).toBeUndefined();
    expect(await resolve({ sessionFile: marker })).toBe(marker);
    const historicalPath = {
      sessionEntry: { sessionFile: artifact, sessionId, updatedAt: 1 },
    };
    expect(await resolve({ sessionId, ...historicalPath })).toBe(
      path.join(sessionsDir, `${sessionId}.jsonl`),
    );
    const sessionTarget = {
      agentId: "main",
      sessionId,
      sessionKey: "agent:main:cost",
      storePath,
    };
    const mismatchedTarget = { ...sessionTarget, sessionKey: "agent:main:other-cost" };
    await upsertSessionEntryCore(mismatchedTarget, {
      sessionId: "other-session",
      updatedAt: 1,
      usageFamilyKey: mismatchedTarget.sessionKey,
      usageFamilySessionIds: ["previous-session", "other-session"],
    });
    const sql = observeMainThreadSql();
    try {
      expect(
        await resolve({ sessionTarget: { ...sessionTarget, sessionKey: "agent:other:cost" } }),
      ).toBeUndefined();
      expect(await resolve({ sessionTarget: mismatchedTarget })).toBeUndefined();
      expect(await resolve({ sessionId: "other-session", sessionTarget })).toBeUndefined();
      expect(await resolve({ agentId: "other", sessionTarget })).toBeUndefined();
      expect(
        await resolve({
          sessionFile: marker,
          sessionTarget: { ...sessionTarget, sessionKey: " " },
        }),
      ).toBeUndefined();
      expect(await resolve({ sessionId: "   ", sessionFile: artifact, sessionTarget })).toBe(
        `sqlite:main:${sessionId}:${fsSync.realpathSync(path.join(root, "openclaw-agent.sqlite"))}`,
      );
      expect(
        await resolveUsageSessionSource({
          agentId: "main",
          sessionId: "other-session",
          sessionTarget: { ...mismatchedTarget, sessionId: "other-session" },
        }),
      ).toMatchObject({
        entry: {
          usageFamilyKey: mismatchedTarget.sessionKey,
          usageFamilySessionIds: ["previous-session", "other-session"],
        },
      });
      sql.expectIdle();
    } finally {
      sql.restore();
    }
    const unreadable = path.join(root, "unreadable.sqlite");
    await fs.writeFile(unreadable, "not a SQLite database");
    await expect(
      resolve({
        sessionFile: artifact,
        sessionTarget: { ...sessionTarget, storePath: unreadable },
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(unreadable, "utf8")).toBe("not a SQLite database");
    const work = new AsyncWorkScope();
    const cancelled = new Error("usage request closed");
    try {
      const resolving = work.track(() => resolve({ sessionTarget }));
      work.beginClose(cancelled);
      await expect(resolving).rejects.toBe(cancelled);
    } finally {
      await work.drain();
    }
  });

  it("keeps symlinked shared-store usage with its logical agent before and after archival", async () => {
    const storePath = state.statePath("custom", "shared-link.sqlite");
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.symlink(database.path, storePath);
    const scopedConfig = {
      ...config,
      session: { store: storePath },
    };
    await state.writeConfig(scopedConfig);
    const fixtures = [
      { agentId: "main", sessionId: "main-usage", tokens: 17 },
      { agentId: "ops", sessionId: `usage-${"x".repeat(300)}`, tokens: 29 },
    ];
    for (const fixture of fixtures) {
      const scope = {
        ...fixture,
        sessionKey: `agent:${fixture.agentId}:usage`,
        storePath,
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: archiveTime });
      await persistSessionTranscriptTurn(scope, {
        messages: [{ message: assistant(fixture.tokens) }],
      });
    }
    for (const archived of [false, true]) {
      if (archived) {
        for (const { agentId } of fixtures) {
          const sessionKey = `agent:${agentId}:usage`;
          await deleteSessionEntryLifecycle({
            agentId,
            storePath,
            archiveTranscript: true,
            target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          });
        }
      }
      for (const { agentId, sessionId, tokens } of fixtures) {
        const files = await listUsageCountedTranscriptStats(agentId);
        expect(files).toEqual([
          expect.objectContaining({ sessionId, kind: archived ? "jsonl" : "sqlite" }),
        ]);
        if (!archived) {
          expect(parseSqliteSessionFileMarker(files[0]?.filePath)).toMatchObject({ agentId });
        }
        expect(await totalUsage(agentId, scopedConfig)).toMatchObject({
          totals: { totalTokens: tokens },
        });
      }
    }
    const legacy = transcript(11);
    const legacyPath = path.join(
      path.dirname(storePath),
      `${legacy.getSessionId()}.jsonl.reset.${archiveStamp}`,
    );
    await fs.writeFile(legacyPath, serialize(legacy));
    for (const { agentId, sessionId, tokens } of fixtures) {
      const files = await listUsageCountedTranscriptStats(agentId);
      expect(files).toHaveLength(2);
      expect(new Set(files.map((file) => file.sessionId))).toEqual(
        new Set([sessionId, legacy.getSessionId()]),
      );
      expect(await totalUsage(agentId, scopedConfig)).toMatchObject({
        totals: { totalTokens: tokens + 11 },
      });
    }
  });

  it("refreshes retained rollups in a request-configured store", async () => {
    const storePath = state.statePath("custom.sqlite");
    const scopedConfig = { ...config, session: { store: storePath } };
    const scope = {
      agentId: "main",
      sessionId: "refresh-usage",
      sessionKey: "agent:main:refresh-usage",
      storePath,
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: archiveTime });
    await persistSessionTranscriptTurn(scope, { messages: [{ message: assistant(17) }] });
    const params = { agentId: "main", config: scopedConfig, startMs: 0, endMs: Date.now() };
    expect(
      await loadCostUsageSummaryFromCache({ ...params, refreshMode: "sync-when-empty" }),
    ).toMatchObject({ totals: { totalTokens: 17 }, cacheStatus: { status: "fresh" } });
    await persistSessionTranscriptTurn(scope, { messages: [{ message: assistant(29) }] });
    const work = new AsyncWorkScope();
    try {
      await work.track(() =>
        loadCostUsageSummaryFromCache({ ...params, refreshMode: "background" }),
      );
      await work.runWhenIdle(() => undefined);
      expect(
        await loadCostUsageSummaryFromCache({ ...params, requestRefresh: false }),
      ).toMatchObject({ totals: { totalTokens: 46 }, cacheStatus: { status: "fresh" } });
      expect(readSessionCostUsageRollupRows("main")).toHaveLength(1);
    } finally {
      await work.drain();
    }
  });

  it("keeps cold usage inventory cheap, restores for scanning, and reports a missing archive", async () => {
    const scope = {
      agentId: "main",
      sessionId: "cold-usage",
      sessionKey: "agent:main:cold-usage",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    const coldConfig = {
      ...config,
      agents: { entries: { [scope.agentId]: {} } },
      session: {
        store: scope.storePath,
        maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
      },
    };
    const ageTranscript = async (target: typeof scope) => {
      await replaceSessionEntry(target, {
        ...expectDefined(loadSessionEntry(target), "usage fixture session"),
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
              .where("session_id", "=", target.sessionId),
          );
        },
        { agentId: "main", env: state.env },
      );
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: archiveTime });
    await persistSessionTranscriptTurn(scope, {
      messages: [{ message: assistant(17) }],
      touchSessionEntry: false,
    });
    const hotScope = { ...scope, sessionId: "hot-usage", sessionKey: "agent:main:hot-usage" };
    await upsertSessionEntryCore(hotScope, {
      sessionId: hotScope.sessionId,
      updatedAt: Date.now(),
    });
    await persistSessionTranscriptTurn(hotScope, { messages: [{ message: assistant(19) }] });
    await replaceSessionEntry(scope, { sessionId: "current-usage", updatedAt: Date.now() });
    await ageTranscript(scope);
    await loadSessionCostSummary({
      agentId: "main",
      config,
      sessionFile: formatSqliteSessionFileMarker(hotScope),
    });
    const before = (await listUsageCountedTranscriptStats("main")).find(
      (file) => file.sessionId === scope.sessionId,
    )!;
    expect(await runSessionColdStorageMaintenance({ config: coldConfig })).toMatchObject({
      archivedTranscripts: 1,
      externalizedTranscripts: 0,
    });
    expect(
      (await listUsageCountedTranscriptStats("main")).find(
        (file) => file.sessionId === scope.sessionId,
      ),
    ).toEqual(before);
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    expect(readSessionColdTranscript(database.db, scope.sessionId)).toBeDefined();
    const sessions = [
      before.filePath,
      formatSqliteSessionFileMarker(hotScope),
      formatSqliteSessionFileMarker(hotScope),
      formatSqliteSessionFileMarker({ ...scope, sessionId: "absent" }),
    ].map((sessionFile) => ({ sessionFile }));
    expect(
      await loadSessionCostSummariesFromCache({
        agentId: "main",
        config,
        sessions,
        requestRefresh: false,
      }),
    ).toMatchObject({
      summaries: [null, { totalTokens: 19 }, { totalTokens: 19 }, null],
      cacheStatus: { cachedFiles: 2, pendingFiles: 2 },
    });
    expect(readSessionColdTranscript(database.db, scope.sessionId)).toBeDefined();
    expect(await totalUsage("main")).toMatchObject({ totals: { totalTokens: 36 } });
    expect(readSessionColdTranscript(database.db, scope.sessionId)).toBeUndefined();
    const rollups = readSessionCostUsageRollupRows("main");
    const missingScope = {
      ...scope,
      sessionKey: "agent:main:missing-usage",
      sessionId: "missing-usage",
    };
    await upsertSessionEntryCore(missingScope, {
      sessionId: missingScope.sessionId,
      updatedAt: archiveTime,
    });
    await persistSessionTranscriptTurn(missingScope, {
      messages: [{ message: assistant(19) }],
      touchSessionEntry: false,
    });
    await ageTranscript(missingScope);
    const missingFile = expectDefined(
      (await listUsageCountedTranscriptStats("main")).find(
        (file) => file.sessionId === missingScope.sessionId,
      ),
      "missing archive inventory",
    );
    expect(await runSessionColdStorageMaintenance({ config: coldConfig })).toMatchObject({
      archivedTranscripts: 1,
      externalizedTranscripts: 0,
    });
    const archive = expectDefined(
      readSessionColdTranscript(database.db, missingScope.sessionId),
      "cold archive",
    );
    await fs.unlink(resolveSessionColdArchivePath(database.path, archive.archive_name));
    await expect(
      loadSessionLogs({ agentId: "main", sessionFile: missingFile.filePath }),
    ).rejects.toThrow(/missing|unreadable/);
    expect(readSessionCostUsageRollupRows("main")).toEqual(rollups);
    expect(readSessionColdTranscript(database.db, missingScope.sessionId)).toBeDefined();
  });

  it.for([
    { encoding: "plain", reason: "reset", agentId: "main" },
    { encoding: "zstd", reason: "deleted", agentId: "worker" },
  ] as const)(
    "discovers and reads $encoding $reason archives for $agentId",
    async ({ encoding, reason, agentId }, { signal }) => {
      const manager = transcript();
      const sessionId = manager.getSessionId();
      const sessionFile = await writeArchive({
        state,
        manager,
        encoding,
        reason,
        agentId,
        generated: true,
      });
      const sourceStats = await fs.stat(sessionFile);
      const sessions = await discoverAllSessions({ agentId });
      expect(sessions).toEqual([
        {
          sessionId,
          sessionFile,
          mtime: sourceStats.mtimeMs,
        },
      ]);

      const resolved = expectDefined(
        await resolveUsageCostTranscriptFile(sessionFile),
        "resolved archive",
      );
      expect(resolved).toMatchObject({
        size: Buffer.byteLength(serialize(manager)),
        mtimeMs: sourceStats.mtimeMs,
      });
      expect(resolved.filePath === sessionFile).toBe(encoding === "plain");

      const cacheLookup = { agentId, config, sessions: [{ sessionId, sessionFile }] };
      expect(readSessionCostUsageRollupRows(agentId)).toEqual([]);
      const work = new AsyncWorkScope();
      try {
        expect(
          await racePromiseWithAbortSignal(
            work.track(() => loadSessionCostSummariesFromCache(cacheLookup)),
            signal,
          ),
        ).toMatchObject({
          summaries: [null],
          cacheStatus: { status: "refreshing", cachedFiles: 0, pendingFiles: 1 },
        });
        await racePromiseWithAbortSignal(
          work.runWhenIdle(() => undefined),
          signal,
        );
        expect(readSessionCostUsageRollupRows(agentId)).toHaveLength(1);
      } finally {
        await work.drain();
      }
      expect(
        await loadSessionCostSummariesFromCache({ ...cacheLookup, requestRefresh: false }),
      ).toMatchObject({
        summaries: [{ sessionId, sessionFile, totalTokens: 17 }],
        cacheStatus: { status: "fresh", cachedFiles: 1, pendingFiles: 0 },
      });

      const lookup = {
        agentId,
        sessionId: expectDefined(sessions[0], "discovered archive").sessionId,
        config,
      };
      const summary = await loadSessionCostSummary(lookup);
      expect(summary).toMatchObject({ sessionFile, totalTokens: 17 });
      expect(await loadSessionLogs(lookup)).toEqual([
        expect.objectContaining({ role: "user", content: "retained archive prompt" }),
        expect.objectContaining({ role: "assistant", tokens: 17 }),
      ]);
      expect(await loadSessionUsageTimeSeries(lookup)).toMatchObject({
        sessionId,
        points: [expect.objectContaining({ totalTokens: 17, cumulativeTokens: 17 })],
      });
      const firstRows = readSessionCostUsageRollupRows(agentId);
      expect(firstRows.map((row) => row.key)).toEqual([resolved.filePath]);
    },
  );

  {
    const encoding = "zstd";
    it(`excludes a ${encoding} archive copy of SQLite only in its owning agent`, async () => {
      const manager = transcript(100);
      const sessionId = manager.getSessionId();
      const sessionKey = "agent:main:main";
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      await upsertSessionEntryCore(
        { sessionKey, storePath },
        { sessionId, updatedAt: archiveTime },
      );
      await persistSessionTranscriptTurn(
        { agentId: "main", sessionId, sessionKey, storePath },
        { messages: [{ message: assistant(17) }], touchSessionEntry: false },
      );
      const mainArchive = await writeArchive({ state, manager, encoding });
      const workerArchive = await writeArchive({ state, manager, encoding, agentId: "worker" });
      const readFile = vi.spyOn(fsSync, "readFileSync");
      try {
        await listUsageCountedTranscriptStats("main");
        expect(readFile.mock.calls.filter(([file]) => file === mainArchive)).toEqual([]);
      } finally {
        readFile.mockRestore();
      }

      const sessions = await discoverAllSessions({ agentId: "main" });
      expect.soft(sessions).toHaveLength(1);
      expect.soft(sessions[0]).toMatchObject({
        sessionId,
        sessionFile: expect.stringContaining(`sqlite:main:${sessionId}:`),
      });
      const lookup = {
        agentId: "main",
        sessionFile: expectDefined(sessions[0], "SQLite session").sessionFile,
        config,
      };
      expect(await loadSessionCostSummary(lookup)).toMatchObject({ totalTokens: 17 });
      expect(await loadSessionUsageTimeSeries(lookup)).toMatchObject({
        points: [{ input: 16, output: 1, totalTokens: 17 }],
      });
      expect(await loadSessionLogs(lookup)).toEqual([
        expect.objectContaining({ role: "assistant", tokens: 17, cost: 0.017 }),
      ]);
      expect(await totalUsage("main")).toMatchObject({ totals: { totalTokens: 17 } });
      expect(await discoverAllSessions({ agentId: "worker" })).toEqual([
        expect.objectContaining({ sessionId, sessionFile: workerArchive }),
      ]);
      expect(await totalUsage("worker")).toMatchObject({ totals: { totalTokens: 100 } });
    });

    it(`keeps newest-archive and primary precedence with ${encoding} archives`, async () => {
      const manager = transcript();
      const sessionId = manager.getSessionId();
      await writeArchive({ state, manager, encoding, reason: "reset" });
      const newestArchive = await writeArchive({
        state,
        manager,
        encoding,
        reason: "deleted",
        mtime: archiveTime + 1000,
      });
      expect(await discoverAllSessions({ agentId: "main" })).toEqual([
        expect.objectContaining({ sessionId, sessionFile: newestArchive }),
      ]);
      const primary = path.join(state.sessionsDir(), `${sessionId}.jsonl`);
      await fs.writeFile(primary, serialize(manager));
      await fs.utimes(primary, new Date(archiveTime - 1000), new Date(archiveTime - 1000));
      expect(await discoverAllSessions({ agentId: "main" })).toEqual([
        expect.objectContaining({ sessionId, sessionFile: primary }),
      ]);
    });
  }

  it("replaces compressed read bytes without changing the durable session identity", async () => {
    const manager = transcript();
    const sessionId = manager.getSessionId();
    const sessionFile = await writeArchive({ state, manager, encoding: "zstd" });
    const lookup = { agentId: "main", sessionId, sessionFile, config };
    expect(await loadSessionCostSummary(lookup)).toMatchObject({ totalTokens: 17 });
    const original = expectDefined(
      await resolveUsageCostTranscriptFile(sessionFile),
      "original archive",
    );
    const originalRows = readSessionCostUsageRollupRows("main");
    expect(originalRows.map((row) => row.key)).toEqual([original.filePath]);

    manager.appendMessage(assistant(29));
    expect(
      await writeArchive({ state, manager, encoding: "zstd", mtime: archiveTime + 2000 }),
    ).toBe(sessionFile);
    const replacement = expectDefined(
      await resolveUsageCostTranscriptFile(sessionFile),
      "replacement archive",
    );
    expect(replacement.filePath).not.toBe(original.filePath);
    expect(await discoverAllSessions({ agentId: "main" })).toEqual([
      expect.objectContaining({ sessionId, sessionFile, mtime: archiveTime + 2000 }),
    ]);
    expect(await refreshCostUsageCacheForAgent({ agentId: "main", config })).toBe("refreshed");
    expect(await loadSessionCostSummary(lookup)).toMatchObject({ sessionFile, totalTokens: 46 });
    expect(await cachedTotal("main")).toMatchObject({
      totals: { totalTokens: 46 },
      cacheStatus: { status: "fresh" },
    });
    const rows = readSessionCostUsageRollupRows("main");
    expect(rows.map((row) => row.key)).toEqual([replacement.filePath]);
    const fingerprint = await resolveUsageCostPricingFingerprint(config, state.agentDir());
    const rollup = expectDefined(
      rows.find((row) => row.key === replacement.filePath),
      "replacement archive rollup",
    );
    expect(decodeUsageCostRollupEnvelope(rollup.valueJson, fingerprint)?.checkpoint).toMatchObject({
      kind: "jsonl",
      parsedOffset: Buffer.byteLength(serialize(manager)),
      observedSize: Buffer.byteLength(serialize(manager)),
      observedMtimeMs: archiveTime + 2000,
    });
    expect(await loadSessionUsageTimeSeries(lookup)).toMatchObject({
      points: [
        expect.objectContaining({ totalTokens: 17 }),
        expect.objectContaining({ totalTokens: 29, cumulativeTokens: 46 }),
      ],
    });
    expect(await loadSessionLogs(lookup)).toHaveLength(3);
    expect(await loadSessionCostSummary(lookup)).toMatchObject({ totalTokens: 46 });
    expect(readSessionCostUsageRollupRows("main")).toEqual(rows);
  });

  it("preserves rollups when a compressed source becomes unreadable", async () => {
    const manager = transcript();
    const sessionFile = await writeArchive({ state, manager, encoding: "zstd" });
    await loadSessionCostSummary({ agentId: "main", sessionFile, config });
    const rows = readSessionCostUsageRollupRows("main");
    expect(rows).toHaveLength(1);
    await fs.writeFile(sessionFile, "not a zstd frame");

    await expect(resolveUsageCostTranscriptFile(sessionFile)).resolves.toBeUndefined();
    expect(await discoverAllSessions({ agentId: "main" })).toMatchObject([
      { sessionId: manager.getSessionId(), sessionFile },
    ]);
    await expect(refreshCostUsageCacheForAgent({ agentId: "main", config })).rejects.toThrow();
    expect(readSessionCostUsageRollupRows("main")).toEqual(rows);
  });
});
