import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { createUsageFixture } from "../agents/test-helpers/usage-fixtures.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
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
import { readSessionColdTranscript as readCold } from "../config/sessions/session-cold-storage-state.js";
import { runSessionColdStorageMaintenance as maintainCold } from "../config/sessions/session-cold-storage.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { withoutMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { racePromiseWithAbortSignal } from "./abort-signal.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import { readSessionCostUsageRollupRows as readRollups } from "./session-cost-usage-cache.test-support.js";
import {
  listUsageCountedTranscriptStats as listTranscripts,
  resolveUsageCostTranscriptFile as resolveTranscript,
} from "./session-cost-usage-collection.test-support.js";
import { resolveUsageCostPricingFingerprint } from "./session-cost-usage-pricing-context.js";
import { decodeUsageCostRollupEnvelope } from "./session-cost-usage-rollup-codec.js";
import {
  discoverAllSessions,
  loadCostUsageSummary,
  loadCostUsageSummaryFromCache,
  loadSessionCostSummariesFromCache as cachedSessions,
  loadSessionCostSummary as sessionSummary,
  loadSessionLogs,
  loadSessionUsageTimeSeries as timeSeries,
  resolveUsageSessionSource,
} from "./session-cost-usage.js";

const usageRange = (agentId: string, scopedConfig = config) => ({
  agentId,
  config: scopedConfig,
  startMs: 0,
  endMs: Date.now() + 86_400_000,
});
const expectTotal = async (agentId: string, tokens: number, scopedConfig = config) =>
  expect(await loadCostUsageSummary(usageRange(agentId, scopedConfig))).toMatchObject({
    totals: { totalTokens: tokens },
  });
const expectDiscovery = async (agentId: string, sessionId: string, sessionFile: string) =>
  expect(await discoverAllSessions({ agentId })).toEqual([
    expect.objectContaining({ sessionId, sessionFile }),
  ]);
const expectFreshTotal = async (summary: Promise<unknown>, totalTokens: number) =>
  expect(await summary).toMatchObject({
    totals: { totalTokens },
    cacheStatus: { status: "fresh" },
  });
async function withWork(run: (work: AsyncWorkScope) => Promise<void>) {
  const work = new AsyncWorkScope();
  try {
    await run(work);
  } finally {
    await work.drain();
  }
}

const archiveTime = Date.UTC(2026, 7, 26, 12);
const archiveStamp = "2026-08-26T12-00-00.000Z";
const generation = "0123456789abcdef0123456789abcdef";
const config = { plugins: { enabled: false } };

function assistant(tokens: number) {
  const usage = createUsageFixture(tokens - 1, 1, tokens);
  return makeAgentAssistantMessage({
    content: [{ type: "text", text: `answer with ${tokens} tokens` }],
    provider: "fixture",
    model: "usage-fixture",
    timestamp: archiveTime,
    usage: {
      ...usage,
      cost: {
        ...usage.cost,
        input: (tokens - 1) / 1000,
        output: 0.001,
        total: tokens / 1000,
      },
    },
  });
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

const serialize = (manager: SessionManager) =>
  [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") +
  "\n";

describe("usage archive identity", () => {
  let state: OpenClawTestState;
  const main = { agentId: "main", config };

  async function writeArchive(
    manager: SessionManager,
    {
      reason = "reset",
      agentId,
      mtime = archiveTime,
      generated = false,
    }: {
      reason?: "reset" | "deleted";
      agentId?: string;
      mtime?: number;
      generated?: boolean;
    } = {},
  ) {
    const encoded = encodeSessionArchiveContent(serialize(manager));
    const directory = state.sessionsDir(agentId);
    await fs.mkdir(directory, { recursive: true });
    const suffix = `${reason}.${archiveStamp}${generated ? `.${generation}` : ""}${encoded.suffix}`;
    const filePath = path.join(directory, `${manager.getSessionId()}.jsonl.${suffix}`);
    await fs.writeFile(filePath, encoded.bytes);
    await fs.utimes(filePath, new Date(mtime), new Date(mtime));
    return filePath;
  }

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "usage-archive-identity" });
    await state.writeConfig(config);
    setRuntimeConfigSnapshot(config);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await state.cleanup();
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  const scopeFor = (
    sessionId: string,
    storePath = path.join(state.sessionsDir(), "sessions.json"),
  ) => ({
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath,
  });
  const seed = async (
    scope: ReturnType<typeof scopeFor>,
    tokens: number,
    touchSessionEntry?: boolean,
    updatedAt = archiveTime,
  ) => {
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt });
    await persistSessionTranscriptTurn(scope, {
      messages: [{ message: assistant(tokens) }],
      touchSessionEntry,
    });
  };
  const usageLookup = (sessionFile: string) => ({ ...main, sessionFile });
  const archiveFixture = async (options: Parameters<typeof writeArchive>[1] = {}) => {
    const manager = transcript();
    const sessionFile = await writeArchive(manager, options);
    return { manager, sessionFile, sessionId: manager.getSessionId() };
  };

  it("uses explicit usage artifacts and validates canonical targets in the worker", async () => {
    const root = state.statePath();
    const sessionsDir = state.sessionsDir();
    const sessionId = "session";
    const storePath = path.join(root, "sessions.json");
    const marker = `sqlite:main:${sessionId}:${storePath}`;
    const stale = `sqlite:main:stale:${storePath}`;
    const foreign = `sqlite:other:${sessionId}:${storePath}`;
    const artifact = path.join(root, `${sessionId}.jsonl`);
    const resolve = async (params: Partial<Parameters<typeof resolveUsageSessionSource>[0]>) =>
      (await resolveUsageSessionSource({ agentId: "main", sessionId, ...params }))?.sessionFile;
    await fs.writeFile(artifact, "explicit artifact");
    const historicalInput = {
      sessionEntry: { sessionFile: marker, sessionId, updatedAt: 1 },
      sessionFile: artifact,
    };
    expect(await resolve(historicalInput)).toBe(artifact);
    expect(await resolve({ ...historicalInput, sessionFile: foreign })).toBeUndefined();
    expect(await resolve({ sessionFile: stale })).toBeUndefined();
    expect(await resolve({ sessionFile: marker })).toBe(marker);
    const historicalPath = { sessionEntry: { sessionFile: artifact, sessionId, updatedAt: 1 } };
    expect(await resolve({ sessionId, ...historicalPath })).toBe(
      path.join(sessionsDir, `${sessionId}.jsonl`),
    );
    const sessionTarget = { agentId: "main", sessionId, sessionKey: "agent:main:cost", storePath };
    const mismatchedTarget = { ...sessionTarget, sessionKey: "agent:main:other-cost" };
    await upsertSessionEntryCore(mismatchedTarget, {
      sessionId: "other-session",
      updatedAt: 1,
      usageFamilyKey: mismatchedTarget.sessionKey,
      usageFamilySessionIds: ["previous-session", "other-session"],
    });
    await withoutMainThreadSql(async () => {
      for (const params of [
        { sessionTarget: { ...sessionTarget, sessionKey: "agent:other:cost" } },
        { sessionTarget: mismatchedTarget },
        { sessionId: "other-session", sessionTarget },
        { agentId: "other", sessionTarget },
        { sessionFile: marker, sessionTarget: { ...sessionTarget, sessionKey: " " } },
      ]) {
        expect(await resolve(params)).toBeUndefined();
      }
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
    });
    const unreadable = path.join(root, "unreadable.sqlite");
    await fs.writeFile(unreadable, "not a SQLite database");
    await expect(
      resolve({
        sessionFile: artifact,
        sessionTarget: { ...sessionTarget, storePath: unreadable },
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(unreadable, "utf8")).toBe("not a SQLite database");
    const cancelled = new Error("usage request closed");
    await withWork(async (work) => {
      const resolving = work.track(() => resolve({ sessionTarget }));
      work.beginClose(cancelled);
      await expect(resolving).rejects.toBe(cancelled);
    });
  });

  it("keeps symlinked shared-store usage with its logical agent before and after archival", async () => {
    const storePath = state.statePath("custom", "shared-link.sqlite");
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.symlink(database.path, storePath);
    const scopedConfig = { ...config, session: { store: storePath } };
    await state.writeConfig(scopedConfig);
    setRuntimeConfigSnapshot(scopedConfig);
    const fixtures = [
      { agentId: "main", sessionId: "main-usage", tokens: 17 },
      { agentId: "ops", sessionId: `usage-${"x".repeat(300)}`, tokens: 29 },
    ].map(({ agentId, sessionId, tokens }) => ({
      agentId,
      sessionId,
      tokens,
      sessionKey: `agent:${agentId}:usage`,
      storePath,
    }));
    for (const fixture of fixtures) {
      await seed(fixture, fixture.tokens);
    }
    for (const archived of [false, true]) {
      if (archived) {
        for (const { agentId, sessionKey } of fixtures) {
          await deleteSessionEntryLifecycle({
            agentId,
            storePath,
            archiveTranscript: true,
            target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          });
        }
      }
      for (const { agentId, sessionId, tokens } of fixtures) {
        const files = await listTranscripts(agentId);
        expect(files).toEqual([
          expect.objectContaining({ sessionId, kind: archived ? "jsonl" : "sqlite" }),
        ]);
        if (!archived) {
          expect(parseSqliteSessionFileMarker(files[0]?.filePath)).toMatchObject({ agentId });
        }
        await expectTotal(agentId, tokens, scopedConfig);
      }
    }
    const legacy = transcript(11);
    const legacyPath = path.join(
      path.dirname(storePath),
      `${legacy.getSessionId()}.jsonl.reset.${archiveStamp}`,
    );
    await fs.writeFile(legacyPath, serialize(legacy));
    for (const { agentId, sessionId, tokens } of fixtures) {
      const files = await listTranscripts(agentId);
      expect(files).toHaveLength(2);
      expect(new Set(files.map((file) => file.sessionId))).toEqual(
        new Set([sessionId, legacy.getSessionId()]),
      );
      await expectTotal(agentId, tokens + 11, scopedConfig);
    }
  });

  it("refreshes retained rollups in a request-configured store", async () => {
    const storePath = state.statePath("custom.sqlite");
    const scopedConfig = { ...config, session: { store: storePath } };
    const scope = scopeFor("refresh-usage", storePath);
    await seed(scope, 17);
    const params = { agentId: "main", config: scopedConfig, startMs: 0, endMs: Date.now() };
    await expectFreshTotal(loadCostUsageSummary(params), 17);
    await persistSessionTranscriptTurn(scope, { messages: [{ message: assistant(29) }] });
    await withWork(async (work) => {
      await work.track(() => loadCostUsageSummaryFromCache(params));
      await work.runWhenIdle(() => undefined);
      await expectFreshTotal(
        loadCostUsageSummaryFromCache({ ...params, requestRefresh: false }),
        46,
      );
      expect(readRollups("main")).toHaveLength(1);
    });
  });

  it("keeps cold usage inventory cheap, restores for scanning, and reports a missing archive", async () => {
    const scope = scopeFor("cold-usage");
    const coldConfig = {
      ...config,
      agents: { entries: { [scope.agentId]: {} } },
      session: {
        store: scope.storePath,
        maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
      },
    };
    const archiveOne = async () =>
      expect(await maintainCold({ config: coldConfig })).toMatchObject({
        archivedTranscripts: 1,
        externalizedTranscripts: 0,
      });
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
    await seed(scope, 17, false);
    const hotScope = { ...scope, sessionId: "hot-usage", sessionKey: "agent:main:hot-usage" };
    await seed(hotScope, 19, undefined, Date.now());
    await replaceSessionEntry(scope, { sessionId: "current-usage", updatedAt: Date.now() });
    await ageTranscript(scope);
    await sessionSummary(usageLookup(formatSqliteSessionFileMarker(hotScope)));
    const inventoryFor = async (sessionId: string) =>
      (await listTranscripts("main")).find((file) => file.sessionId === sessionId);
    const before = (await inventoryFor(scope.sessionId))!;
    await archiveOne();
    expect(await inventoryFor(scope.sessionId)).toEqual(before);
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    expect(readCold(database.db, scope.sessionId)).toBeDefined();
    const sessions = [
      before.filePath,
      formatSqliteSessionFileMarker(hotScope),
      formatSqliteSessionFileMarker(hotScope),
      formatSqliteSessionFileMarker({ ...scope, sessionId: "absent" }),
    ].map((sessionFile) => ({ sessionFile }));
    expect(await cachedSessions({ ...main, sessions, requestRefresh: false })).toMatchObject({
      summaries: [null, { totalTokens: 19 }, { totalTokens: 19 }, null],
      cacheStatus: { cachedFiles: 2, pendingFiles: 2 },
    });
    expect(readCold(database.db, scope.sessionId)).toBeDefined();
    await expectTotal("main", 36);
    expect(readCold(database.db, scope.sessionId)).toBeUndefined();
    const rollups = readRollups("main");
    const missingScope = scopeFor("missing-usage", scope.storePath);
    await seed(missingScope, 19, false);
    await ageTranscript(missingScope);
    const missingFile = expectDefined(
      await inventoryFor(missingScope.sessionId),
      "missing archive inventory",
    );
    await archiveOne();
    const archive = expectDefined(readCold(database.db, missingScope.sessionId), "cold archive");
    await fs.unlink(resolveSessionColdArchivePath(database.path, archive.archive_name));
    await expect(
      loadSessionLogs({ agentId: "main", sessionFile: missingFile.filePath }),
    ).rejects.toThrow(/missing|unreadable/);
    expect(readRollups("main")).toEqual(rollups);
    expect(readCold(database.db, missingScope.sessionId)).toBeDefined();
  });

  it("discovers and reads compressed deleted archives for a non-main agent", async ({ signal }) => {
    const agentId = "worker";
    const { manager, sessionId, sessionFile } = await archiveFixture({
      reason: "deleted",
      agentId,
      generated: true,
    });
    const sourceStats = await fs.stat(sessionFile);
    const sessions = await discoverAllSessions({ agentId });
    expect(sessions).toEqual([{ sessionId, sessionFile, mtime: sourceStats.mtimeMs }]);

    const resolved = expectDefined(await resolveTranscript(sessionFile), "resolved archive");
    expect(resolved).toMatchObject({
      size: Buffer.byteLength(serialize(manager)),
      mtimeMs: sourceStats.mtimeMs,
    });
    expect(resolved.filePath).not.toBe(sessionFile);

    const cacheLookup = { agentId, config, sessions: [{ sessionId, sessionFile }] };
    expect(readRollups(agentId)).toEqual([]);
    await withWork(async (work) => {
      expect(
        await racePromiseWithAbortSignal(
          work.track(() => cachedSessions(cacheLookup)),
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
      expect(readRollups(agentId)).toHaveLength(1);
    });
    expect(await cachedSessions({ ...cacheLookup, requestRefresh: false })).toMatchObject({
      summaries: [{ sessionId, sessionFile, totalTokens: 17 }],
      cacheStatus: { status: "fresh", cachedFiles: 1, pendingFiles: 0 },
    });

    const lookup = { agentId, sessionId, config };
    expect(await sessionSummary(lookup)).toMatchObject({ sessionFile, totalTokens: 17 });
    expect(await loadSessionLogs(lookup)).toEqual([
      expect.objectContaining({ role: "user", content: "retained archive prompt" }),
      expect.objectContaining({ role: "assistant", tokens: 17 }),
    ]);
    expect(await timeSeries(lookup)).toMatchObject({
      sessionId,
      points: [expect.objectContaining({ totalTokens: 17, cumulativeTokens: 17 })],
    });
    expect(readRollups(agentId).map((row) => row.key)).toEqual([resolved.filePath]);
  });

  it("excludes a compressed archive copy of SQLite only in its owning agent", async () => {
    const manager = transcript(100);
    const sessionId = manager.getSessionId();
    await seed({ ...scopeFor(sessionId), sessionKey: "agent:main:main" }, 17, false);
    const mainArchive = await writeArchive(manager);
    const workerArchive = await writeArchive(manager, { agentId: "worker" });
    const readFile = vi.spyOn(fsSync, "readFileSync");
    await listTranscripts("main");
    expect(readFile.mock.calls.filter(([file]) => file === mainArchive)).toEqual([]);
    readFile.mockRestore();

    const sessions = await discoverAllSessions({ agentId: "main" });
    expect.soft(sessions).toEqual([
      expect.objectContaining({
        sessionId,
        sessionFile: expect.stringContaining(`sqlite:main:${sessionId}:`),
      }),
    ]);
    const lookup = usageLookup(expectDefined(sessions[0], "SQLite session").sessionFile);
    expect(await sessionSummary(lookup)).toMatchObject({ totalTokens: 17 });
    expect(await timeSeries(lookup)).toMatchObject({
      points: [{ input: 16, output: 1, totalTokens: 17 }],
    });
    expect(await loadSessionLogs(lookup)).toEqual([
      expect.objectContaining({ role: "assistant", tokens: 17, cost: 0.017 }),
    ]);
    await expectTotal("main", 17);
    await expectDiscovery("worker", sessionId, workerArchive);
    await expectTotal("worker", 100);
  });

  it("keeps newest-archive and primary precedence with compressed archives", async () => {
    const manager = transcript();
    const sessionId = manager.getSessionId();
    await writeArchive(manager);
    const newestArchive = await writeArchive(manager, {
      reason: "deleted",
      mtime: archiveTime + 1000,
    });
    await expectDiscovery("main", sessionId, newestArchive);
    const primary = path.join(state.sessionsDir(), `${sessionId}.jsonl`);
    await fs.writeFile(primary, serialize(manager));
    await fs.utimes(primary, new Date(archiveTime - 1000), new Date(archiveTime - 1000));
    await expectDiscovery("main", sessionId, primary);
  });
  it("replaces compressed read bytes without changing the durable session identity", async () => {
    const { manager, sessionId, sessionFile } = await archiveFixture();
    const lookup = { ...usageLookup(sessionFile), sessionId };
    expect(await sessionSummary(lookup)).toMatchObject({ totalTokens: 17 });
    const original = expectDefined(await resolveTranscript(sessionFile), "original archive");
    expect(readRollups("main").map((row) => row.key)).toEqual([original.filePath]);

    manager.appendMessage(assistant(29));
    expect(await writeArchive(manager, { mtime: archiveTime + 2000 })).toBe(sessionFile);
    const replacement = expectDefined(await resolveTranscript(sessionFile), "replacement archive");
    expect(replacement.filePath).not.toBe(original.filePath);
    expect(await discoverAllSessions({ agentId: "main" })).toEqual([
      expect.objectContaining({ sessionId, sessionFile, mtime: archiveTime + 2000 }),
    ]);
    expect(await refreshCostUsageCacheForAgent(main)).toBe("refreshed");
    expect(await sessionSummary(lookup)).toMatchObject({ sessionFile, totalTokens: 46 });
    await expectFreshTotal(
      loadCostUsageSummaryFromCache({ ...usageRange("main"), requestRefresh: false }),
      46,
    );
    const rows = readRollups("main");
    expect(rows.map((row) => row.key)).toEqual([replacement.filePath]);
    const fingerprint = await resolveUsageCostPricingFingerprint(config, state.agentDir());
    const rollup = expectDefined(rows[0], "replacement archive rollup");
    const size = Buffer.byteLength(serialize(manager));
    expect(decodeUsageCostRollupEnvelope(rollup.valueJson, fingerprint)?.checkpoint).toMatchObject({
      kind: "jsonl",
      parsedOffset: size,
      observedSize: size,
      observedMtimeMs: archiveTime + 2000,
    });
    expect(await timeSeries(lookup)).toMatchObject({
      points: [
        expect.objectContaining({ totalTokens: 17 }),
        expect.objectContaining({ totalTokens: 29, cumulativeTokens: 46 }),
      ],
    });
    expect(await loadSessionLogs(lookup)).toHaveLength(3);
    expect(await sessionSummary(lookup)).toMatchObject({ totalTokens: 46 });
    expect(readRollups("main")).toEqual(rows);
  });

  it("preserves rollups when a compressed source becomes unreadable", async () => {
    const { manager, sessionFile } = await archiveFixture();
    await sessionSummary(usageLookup(sessionFile));
    const rows = readRollups("main");
    expect(rows).toHaveLength(1);
    await fs.writeFile(sessionFile, "not a zstd frame");

    await expect(resolveTranscript(sessionFile)).resolves.toBeUndefined();
    expect(await discoverAllSessions({ agentId: "main" })).toMatchObject([
      { sessionId: manager.getSessionId(), sessionFile },
    ]);
    await expect(refreshCostUsageCacheForAgent(main)).rejects.toThrow();
    expect(readRollups("main")).toEqual(rows);
  });
});
