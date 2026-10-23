import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { beginSessionEffect } from "../../sessions/session-controller.lifecycle.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import * as diskBudget from "./disk-budget.js";
import { measureSessionPhysicalDiskUsage } from "./disk-budget.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "./session-accessor.js";
import { finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort } from "./session-accessor.sqlite-maintenance.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import * as archivePruning from "./session-history-archive-pruning.js";
import { createSessionHistoryBudgetFixture } from "./session-history-budget.test-support.js";
import {
  enforceSqliteSessionHistoryDiskBudget,
  inspectSqliteSessionHistoryDiskBudget,
} from "./session-history-eviction.js";
import { planLiveEvictionInDatabase } from "./session-live-eviction-plan.worker.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import {
  prepareSessionMaintenancePreservation,
  registerSessionMaintenancePreserveKeysProvider,
} from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

describe("SQLite live-node disk budget eviction", () => {
  let testState: OpenClawTestState;
  let tempDir: string;
  let storePath: string;
  const { createHistoricalTranscript, database, sessionExists, settlePhysicalUsage } =
    createSessionHistoryBudgetFixture(() => ({ storePath, tempDir }));

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      prefix: "openclaw-session-live-budget-",
      layout: "state-only",
    });
    tempDir = testState.sessionsDir();
    fs.mkdirSync(tempDir, { recursive: true });
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(async () => {
    resetAgentRunRegistryForTest();
    vi.restoreAllMocks();
    await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "warn",
      maintenance: { maxDiskBytes: null, highWaterBytes: null },
    });
    closeOpenClawAgentDatabasesForTest();
    await testState.cleanup();
  });

  it("evicts idle durable live nodes under disk pressure after historical reclaim", async () => {
    const mainKey = "agent:main:main";
    const idleThreadKey = "agent:main:slack:channel:C1:thread:1";
    const admittedThreadKey = "agent:main:slack:channel:C2:thread:2";
    await replaceSessionEntry(
      { sessionKey: mainKey, storePath },
      { sessionId: "live-main", updatedAt: 40 },
    );
    await appendTranscriptMessage(
      { sessionId: "live-main", sessionKey: mainKey, storePath },
      { message: { role: "user", content: "main keep" } },
    );
    await createHistoricalTranscript({
      content: "tiny history",
      nextSessionId: "scratch-live",
      sessionId: "scratch-old",
      sessionKey: "agent:main:scratch",
      updatedAt: 1,
    });
    await replaceSessionEntry(
      { sessionKey: idleThreadKey, storePath },
      { sessionId: "idle-thread-live", updatedAt: 10 },
    );
    await appendTranscriptMessage(
      { sessionId: "idle-thread-live", sessionKey: idleThreadKey, storePath },
      { message: { role: "user", content: "idle live " + "x".repeat(64 * 1024) } },
    );
    await replaceSessionEntry(
      { sessionKey: admittedThreadKey, storePath },
      { sessionId: "admitted-thread", updatedAt: 5 },
    );
    await appendTranscriptMessage(
      { sessionId: "admitted-thread", sessionKey: admittedThreadKey, storePath },
      { message: { role: "user", content: "admitted keep" } },
    );
    const admission = await beginSessionEffect({
      scope: storePath,
      identities: [admittedThreadKey],
      assertAllowed: () => {},
    });
    try {
      settlePhysicalUsage();
      const before = await measureSessionPhysicalDiskUsage(storePath);
      const maintenance = {
        maxDiskBytes: before.totalBytes - 1,
        maxDiskBytesExplicit: true,
        highWaterBytes: Math.max(1, before.totalBytes - 1),
      };
      const inspected = await inspectSqliteSessionHistoryDiskBudget({
        storePath,
        mode: "enforce",
        maintenance,
      });
      const result = await enforceSqliteSessionHistoryDiskBudget({
        storePath,
        mode: "enforce",
        maintenance,
      });

      expect(inspected.wouldMutate).toBe(true);
      expect(result?.removedEntries).toBeGreaterThanOrEqual(1);
      expect(sessionExists("idle-thread-live")).toBe(false);
      expect(sessionExists("live-main")).toBe(true);
      expect(sessionExists("admitted-thread")).toBe(true);
    } finally {
      admission.release();
    }
  });

  it("inspects and evicts idle durable live nodes when no historical generations remain", async () => {
    const mainKey = "agent:main:main";
    const idleThreadKey = "agent:main:slack:channel:c3:thread:3";
    const admittedThreadKey = "agent:main:slack:channel:c4:thread:4";
    await replaceSessionEntry(
      { sessionKey: mainKey, storePath },
      { sessionId: "live-main", updatedAt: 40 },
    );
    await appendTranscriptMessage(
      { sessionId: "live-main", sessionKey: mainKey, storePath },
      { message: { role: "user", content: "main keep" } },
    );
    await replaceSessionEntry(
      { sessionKey: idleThreadKey, storePath },
      { sessionId: "idle-thread-live", updatedAt: 10 },
    );
    await appendTranscriptMessage(
      { sessionId: "idle-thread-live", sessionKey: idleThreadKey, storePath },
      { message: { role: "user", content: "idle live " + "x".repeat(64 * 1024) } },
    );
    await replaceSessionEntry(
      { sessionKey: admittedThreadKey, storePath },
      { sessionId: "admitted-thread", updatedAt: 5 },
    );
    await appendTranscriptMessage(
      { sessionId: "admitted-thread", sessionKey: admittedThreadKey, storePath },
      { message: { role: "user", content: "admitted keep" } },
    );
    const admission = await beginSessionEffect({
      scope: storePath,
      identities: [admittedThreadKey],
      assertAllowed: () => {},
    });
    try {
      settlePhysicalUsage();
      expect(countHistoricalSessionIds()).toBe(0);
      expect(sessionNodeExists(idleThreadKey)).toBe(true);
      const before = await measureSessionPhysicalDiskUsage(storePath);
      const maintenance = {
        maxDiskBytes: before.totalBytes - 1,
        maxDiskBytesExplicit: true,
        highWaterBytes: Math.max(1, before.totalBytes - 1),
      };
      const inspected = await inspectSqliteSessionHistoryDiskBudget({
        storePath,
        mode: "enforce",
        maintenance,
      });
      const result = await enforceSqliteSessionHistoryDiskBudget({
        storePath,
        mode: "enforce",
        maintenance,
      });

      expect(inspected.wouldMutate).toBe(true);
      expect(result?.removedEntries).toBeGreaterThanOrEqual(1);
      expect(sessionExists("idle-thread-live")).toBe(false);
      expect(sessionNodeExists(idleThreadKey)).toBe(false);
      expect(sessionExists("live-main")).toBe(true);
      expect(sessionNodeExists(mainKey)).toBe(true);
      expect(sessionExists("admitted-thread")).toBe(true);
      expect(sessionNodeExists(admittedThreadKey)).toBe(true);
    } finally {
      admission.release();
    }
  });

  it("preserves recently active live nodes under physical pressure", async () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const mainKey = "agent:main:main";
    const recentKey = "agent:main:slack:channel:c6:thread:6";
    const idleThreadKey = "agent:main:slack:channel:c5:thread:5";
    await replaceSessionEntry(
      { sessionKey: mainKey, storePath },
      { sessionId: "live-main", updatedAt: now },
    );
    await appendTranscriptMessage(
      { sessionId: "live-main", sessionKey: mainKey, storePath },
      { message: { role: "user", content: "main keep" } },
    );
    await replaceSessionEntry(
      { sessionKey: recentKey, storePath },
      { sessionId: "recent-live", updatedAt: now },
    );
    await appendTranscriptMessage(
      { sessionId: "recent-live", sessionKey: recentKey, storePath },
      { message: { role: "user", content: "recent keep" } },
    );
    await replaceSessionEntry(
      { sessionKey: idleThreadKey, storePath },
      { sessionId: "idle-thread-live", updatedAt: 10 },
    );
    await appendTranscriptMessage(
      { sessionId: "idle-thread-live", sessionKey: idleThreadKey, storePath },
      { message: { role: "user", content: "idle live " + "x".repeat(64 * 1024) } },
    );
    settlePhysicalUsage();
    expect(countHistoricalSessionIds()).toBe(0);
    const before = await measureSessionPhysicalDiskUsage(storePath);
    const maintenance = {
      maxDiskBytes: before.totalBytes - 1,
      maxDiskBytesExplicit: true,
      highWaterBytes: Math.max(1, before.totalBytes - 1),
      preserveRecentMs: 7 * dayMs,
    };
    const inspected = await inspectSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "enforce",
      maintenance,
    });
    const result = await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "enforce",
      maintenance,
    });

    expect(inspected.wouldMutate).toBe(true);
    expect(result?.removedEntries).toBeGreaterThanOrEqual(1);
    expect(sessionExists("idle-thread-live")).toBe(false);
    expect(sessionNodeExists(idleThreadKey)).toBe(false);
    expect(sessionExists("recent-live")).toBe(true);
    expect(sessionNodeExists(recentKey)).toBe(true);
    expect(sessionExists("live-main")).toBe(true);
  });

  it("keeps a provider-protected thread that appears while live eviction waits", async () => {
    const oldestKey = "agent:main:slack:channel:c10:thread:10";
    const newerKey = "agent:main:slack:channel:c11:thread:11";
    await replaceSessionEntry(
      { sessionKey: oldestKey, storePath },
      { sessionId: "provider-oldest", updatedAt: 5 },
    );
    await appendTranscriptMessage(
      { sessionId: "provider-oldest", sessionKey: oldestKey, storePath },
      { message: { role: "user", content: "oldest " + "x".repeat(64 * 1024) } },
    );
    await replaceSessionEntry(
      { sessionKey: newerKey, storePath },
      { sessionId: "provider-newer", updatedAt: 15 },
    );
    await appendTranscriptMessage(
      { sessionId: "provider-newer", sessionKey: newerKey, storePath },
      { message: { role: "user", content: "newer " + "y".repeat(64 * 1024) } },
    );
    settlePhysicalUsage();
    const before = await measureSessionPhysicalDiskUsage(storePath);
    let preserveCalls = 0;
    let underBudget = false;
    const realMeasure = diskBudget.measureSessionPhysicalDiskUsage;
    vi.spyOn(diskBudget, "measureSessionPhysicalDiskUsage").mockImplementation(
      async (targetPath) => {
        const usage = await realMeasure(targetPath);
        return underBudget ? { ...usage, totalBytes: 1 } : usage;
      },
    );
    const unregister = registerSessionMaintenancePreserveKeysProvider(async () => ({
      capture: () => {
        preserveCalls += 1;
        if (preserveCalls < 2) {
          return [];
        }
        underBudget = true;
        return [oldestKey];
      },
      dispose() {},
    }));
    try {
      const result = await enforceSqliteSessionHistoryDiskBudget({
        storePath,
        mode: "enforce",
        maintenance: {
          maxDiskBytes: before.totalBytes - 1,
          maxDiskBytesExplicit: true,
          highWaterBytes: Math.max(1, before.totalBytes - 1),
        },
      });
      expect(preserveCalls).toBeGreaterThanOrEqual(2);
      expect(result?.removedEntries ?? 0).toBe(0);
      expect(sessionNodeExists(oldestKey)).toBe(true);
      expect(sessionNodeExists(newerKey)).toBe(true);
    } finally {
      unregister();
    }
  });

  it("stops live eviction when the post-delete checkpoint is blocked", async () => {
    const oldestKey = "agent:main:slack:channel:c12:thread:12";
    const newerKey = "agent:main:slack:channel:c13:thread:13";
    await replaceSessionEntry(
      { sessionKey: oldestKey, storePath },
      { sessionId: "checkpoint-oldest", updatedAt: 5 },
    );
    await appendTranscriptMessage(
      { sessionId: "checkpoint-oldest", sessionKey: oldestKey, storePath },
      { message: { role: "user", content: "oldest " + "x".repeat(64 * 1024) } },
    );
    await replaceSessionEntry(
      { sessionKey: newerKey, storePath },
      { sessionId: "checkpoint-newer", updatedAt: 15 },
    );
    await appendTranscriptMessage(
      { sessionId: "checkpoint-newer", sessionKey: newerKey, storePath },
      { message: { role: "user", content: "newer " + "y".repeat(64 * 1024) } },
    );
    settlePhysicalUsage();
    const before = await measureSessionPhysicalDiskUsage(storePath);
    const realReclaim = archivePruning.reclaimSqliteFreePages;
    vi.spyOn(archivePruning, "reclaimSqliteFreePages").mockImplementation(
      async (databaseOptions, diagnostics, limits) => {
        if (diagnostics?.trigger === "after-eviction") {
          return false;
        }
        return await realReclaim(databaseOptions, diagnostics, limits);
      },
    );
    const result = await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "enforce",
      maintenance: {
        maxDiskBytes: before.totalBytes - 1,
        maxDiskBytesExplicit: true,
        highWaterBytes: Math.max(1, before.totalBytes - 1),
      },
    });
    const after = await measureSessionPhysicalDiskUsage(storePath);
    expect(result?.removedEntries).toBe(1);
    expect(result?.totalBytesAfter).toBe(after.totalBytes);
    expect(result?.walBytesAfter).toBe(after.databaseWalBytes);
    expect(sessionNodeExists(oldestKey)).toBe(false);
    expect(sessionNodeExists(newerKey)).toBe(true);
  });

  it("keeps idle durable live nodes under the default disk budget", async () => {
    const threadKey = "agent:main:slack:channel:c14:thread:14";
    await replaceSessionEntry(
      { sessionKey: threadKey, storePath },
      { sessionId: "default-budget-thread", updatedAt: 5 },
    );
    await appendTranscriptMessage(
      { sessionId: "default-budget-thread", sessionKey: threadKey, storePath },
      { message: { role: "user", content: "idle " + "x".repeat(64 * 1024) } },
    );
    settlePhysicalUsage();
    const before = await measureSessionPhysicalDiskUsage(storePath);
    const maintenance = {
      maxDiskBytes: before.totalBytes - 1,
      highWaterBytes: Math.max(1, before.totalBytes - 1),
    };
    const inspected = await inspectSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "enforce",
      maintenance,
    });
    const result = await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "enforce",
      maintenance,
    });

    expect(inspected.wouldMutate).toBe(false);
    expect(result?.removedEntries ?? 0).toBe(0);
    expect(sessionNodeExists(threadKey.toLowerCase())).toBe(true);
    expect(sessionExists("default-budget-thread")).toBe(true);
  });

  it("keeps the operator active key and evicts the next idle thread", async () => {
    const activeKey = "agent:main:slack:channel:c17:thread:17";
    const idleKey = "agent:main:slack:channel:c18:thread:18";
    await replaceSessionEntry(
      { sessionKey: activeKey, storePath },
      { sessionId: "active-oldest", updatedAt: 5 },
    );
    await appendTranscriptMessage(
      { sessionId: "active-oldest", sessionKey: activeKey, storePath },
      { message: { role: "user", content: "active " + "x".repeat(64 * 1024) } },
    );
    await replaceSessionEntry(
      { sessionKey: idleKey, storePath },
      { sessionId: "idle-newer", updatedAt: 15 },
    );
    await appendTranscriptMessage(
      { sessionId: "idle-newer", sessionKey: idleKey, storePath },
      { message: { role: "user", content: "idle " + "y".repeat(64 * 1024) } },
    );
    settlePhysicalUsage();
    const before = await measureSessionPhysicalDiskUsage(storePath);
    const result = await enforceSqliteSessionHistoryDiskBudget({
      activeSessionKey: "agent:main:slack:channel:C17:thread:17",
      storePath,
      mode: "enforce",
      maintenance: {
        maxDiskBytes: before.totalBytes - 1,
        maxDiskBytesExplicit: true,
        highWaterBytes: Math.max(1, before.totalBytes - 1),
      },
    });

    expect(result?.removedEntries).toBe(1);
    expect(sessionNodeExists(activeKey)).toBe(true);
    expect(sessionNodeExists(idleKey)).toBe(false);
  });

  it("previews and applies no eviction when only the active key is eligible", async () => {
    const activeKey = "agent:main:slack:channel:c19:thread:19";
    await replaceSessionEntry(
      { sessionKey: activeKey, storePath },
      { sessionId: "active-only", updatedAt: 5 },
    );
    await appendTranscriptMessage(
      { sessionId: "active-only", sessionKey: activeKey, storePath },
      { message: { role: "user", content: "active " + "x".repeat(64 * 1024) } },
    );
    settlePhysicalUsage();
    const before = await measureSessionPhysicalDiskUsage(storePath);
    const budget = {
      activeSessionKey: "agent:main:slack:channel:C19:thread:19",
      storePath,
      mode: "enforce" as const,
      maintenance: {
        maxDiskBytes: before.totalBytes - 1,
        maxDiskBytesExplicit: true,
        highWaterBytes: Math.max(1, before.totalBytes - 1),
      },
    };

    await expect(inspectSqliteSessionHistoryDiskBudget(budget)).resolves.toMatchObject({
      wouldMutate: false,
    });
    const result = await enforceSqliteSessionHistoryDiskBudget(budget);

    expect(result?.removedEntries).toBe(0);
    expect(sessionNodeExists(activeKey)).toBe(true);
  });

  it("skips an idle thread whose transcript is cold", async () => {
    const coldKey = "agent:main:slack:channel:c15:thread:15";
    const hotKey = "agent:main:slack:channel:c16:thread:16";
    await replaceSessionEntry(
      { sessionKey: coldKey, storePath },
      { sessionId: "cold-oldest", updatedAt: 5 },
    );
    await appendTranscriptMessage(
      { sessionId: "cold-oldest", sessionKey: coldKey, storePath },
      { message: { role: "user", content: "cold " + "x".repeat(64 * 1024) } },
    );
    await replaceSessionEntry(
      { sessionKey: hotKey, storePath },
      { sessionId: "hot-newer", updatedAt: 15 },
    );
    await appendTranscriptMessage(
      { sessionId: "hot-newer", sessionKey: hotKey, storePath },
      { message: { role: "user", content: "hot " + "y".repeat(64 * 1024) } },
    );
    markCold("cold-oldest");
    settlePhysicalUsage();
    const before = await measureSessionPhysicalDiskUsage(storePath);
    const result = await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "enforce",
      maintenance: {
        maxDiskBytes: before.totalBytes - 1,
        maxDiskBytesExplicit: true,
        highWaterBytes: Math.max(1, before.totalBytes - 1),
      },
    });

    expect(result?.removedEntries).toBe(1);
    expect(sessionNodeExists(coldKey)).toBe(true);
    expect(sessionNodeExists(hotKey)).toBe(false);
  });

  it("skips a thread whose older generation is cold while the current transcript is hot", async () => {
    const coldKey = "agent:main:slack:channel:c18:thread:18";
    const hotKey = "agent:main:slack:channel:c19:thread:19";
    await replaceSessionEntry(
      { sessionKey: coldKey, storePath },
      { sessionId: "cold-generation", updatedAt: 5 },
    );
    await appendTranscriptMessage(
      { sessionId: "cold-generation", sessionKey: coldKey, storePath },
      { message: { role: "user", content: "old " + "x".repeat(64 * 1024) } },
    );
    await resetSessionEntryLifecycle({
      storePath,
      target: { canonicalKey: coldKey, storeKeys: [coldKey] },
      buildNextEntry: () => ({ sessionId: "hot-current", updatedAt: 6 }),
    });
    await appendTranscriptMessage(
      { sessionId: "hot-current", sessionKey: coldKey, storePath },
      { message: { role: "user", content: "current" } },
    );
    await replaceSessionEntry(
      { sessionKey: hotKey, storePath },
      { sessionId: "hot-only", updatedAt: 15 },
    );
    await appendTranscriptMessage(
      { sessionId: "hot-only", sessionKey: hotKey, storePath },
      { message: { role: "user", content: "hot " + "y".repeat(64 * 1024) } },
    );
    markCold("cold-generation");
    settlePhysicalUsage();
    const before = await measureSessionPhysicalDiskUsage(storePath);
    const result = await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "enforce",
      maintenance: {
        maxDiskBytes: before.totalBytes - 1,
        maxDiskBytesExplicit: true,
        highWaterBytes: Math.max(1, before.totalBytes - 1),
      },
    });

    expect(result?.removedEntries).toBe(1);
    expect(sessionNodeExists(coldKey)).toBe(true);
    expect(sessionExists("hot-current")).toBe(true);
    expect(sessionExists("cold-generation")).toBe(true);
    expect(sessionNodeExists(hotKey)).toBe(false);
  });

  it("keeps a thread whose transcript goes cold before the eviction commits", async () => {
    const threadKey = "agent:main:slack:channel:c17:thread:17";
    await replaceSessionEntry(
      { sessionKey: threadKey, storePath },
      { sessionId: "late-cold", updatedAt: 5 },
    );
    await appendTranscriptMessage(
      { sessionId: "late-cold", sessionKey: threadKey, storePath },
      { message: { role: "user", content: "late " + "x".repeat(64 * 1024) } },
    );
    const prepared = await prepareSessionMaintenancePreservation(storePath);
    const snapshot = prepared.capture();
    prepared.dispose();
    const live = planLiveEvictionInDatabase(database(), {
      archiveDirectory: path.join(tempDir, "archives"),
      baseKeys: [],
      preserveRecentMs: null,
      skipSessionKeys: [],
      snapshot,
      unprotectSessionKeys: [],
    });
    expect(live.plan.entryRemovals.map((removal) => removal.sessionKey)).toEqual([threadKey]);
    markCold("late-cold");
    const target = resolveSqliteTargetFromSessionStorePath(storePath);
    const removed: string[] = [];
    await finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(
      { agentId: target.agentId ?? "main", env: process.env, path: target.path ?? "" },
      [live.plan],
      { onEntryRemoved: (sessionKey) => removed.push(sessionKey) },
    );

    expect(removed).toEqual([]);
    expect(sessionNodeExists(threadKey.toLowerCase())).toBe(true);
  });

  it("marks only an operator-set budget as explicit", () => {
    expect(resolveMaintenanceConfigFromInput().maxDiskBytesExplicit).toBe(false);
    expect(resolveMaintenanceConfigFromInput({ maxDiskBytes: "400mb" }).maxDiskBytesExplicit).toBe(
      true,
    );
    expect(resolveMaintenanceConfigFromInput({ maxDiskBytes: false }).maxDiskBytesExplicit).toBe(
      false,
    );
    expect(resolveMaintenanceConfigFromInput({ maxDiskBytes: "big" }).maxDiskBytesExplicit).toBe(
      false,
    );
  });

  it("does not wipe live durables when highWaterBytes is 0", async () => {
    const threadKey = "agent:main:slack:channel:C9:thread:9";
    await replaceSessionEntry(
      { sessionKey: threadKey, storePath },
      { sessionId: "live-durable", updatedAt: 2 },
    );
    await appendTranscriptMessage(
      { sessionId: "live-durable", sessionKey: threadKey, storePath },
      { message: { role: "user", content: "live durable keep" } },
    );
    await createHistoricalTranscript({
      content: "oldest " + "x".repeat(64 * 1024),
      nextSessionId: "newer-history",
      sessionId: "oldest-history",
      sessionKey: "agent:main:history-order",
      updatedAt: 10,
    });
    settlePhysicalUsage();
    expect(sessionExists("oldest-history")).toBe(true);
    expect(sessionExists("live-durable")).toBe(true);
    const before = await measureSessionPhysicalDiskUsage(storePath);

    const result = await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "enforce",
      maintenance: {
        maxDiskBytes: before.totalBytes - 1,
        maxDiskBytesExplicit: true,
        highWaterBytes: 0,
      },
    });

    expect(sessionExists("live-durable")).toBe(true);
    expect(sessionNodeExists(threadKey.toLowerCase())).toBe(true);
    expect(result?.overBudget).toBe(true);
  });

  function markCold(sessionId: string): void {
    database()
      .db.prepare(
        `INSERT INTO session_transcript_cold_archives
          (session_id, generation, archive_name, archive_sha256, event_count, raw_bytes,
           archive_bytes, last_seq, archived_at, storage, archive_blob)
         VALUES (?, 'test', ?, ?, 1, 1, 1, 1, ?, 'sqlite', x'00')`,
      )
      .run(sessionId, `${sessionId}.cold.zst`, "0".repeat(64), Date.now());
  }

  function sessionNodeExists(sessionKey: string): boolean {
    const owner = database();
    const db = getSessionKysely(owner.db);
    return (
      executeSqliteQuerySync(
        owner.db,
        db.selectFrom("session_nodes").select("session_key").where("session_key", "=", sessionKey),
      ).rows.length === 1
    );
  }

  function countHistoricalSessionIds(): number {
    const owner = database();
    const db = getSessionKysely(owner.db);
    const liveIds = new Set(
      executeSqliteQuerySync(
        owner.db,
        db.selectFrom("session_nodes").select("current_session_id"),
      ).rows.map((row) => row.current_session_id),
    );
    return executeSqliteQuerySync(
      owner.db,
      db.selectFrom("session_windows").select("session_id"),
    ).rows.filter((row) => !liveIds.has(row.session_id)).length;
  }
});
