/**
 * End-to-end integration tests for parallel sessions with shared memory.
 *
 * These tests use the REAL node:sqlite backend — no mocks.
 * They verify the full lifecycle: create sessions, save memories,
 * auto-promote to global knowledge, hibernate with persistence,
 * resume from disk, concurrent session limits,
 * cross-session knowledge sharing, and work item management.
 *
 * SQLite-first: no in-memory arrays for memories or knowledge.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ParallelSessionManager } from "./parallel-session-manager.js";
import { SharedMemoryBackend } from "./shared-memory-backend.js";

// node:sqlite requires Node 22+. Skip e2e tests on older runtimes.
let hasNodeSqlite = false;
try {
  await import("node:sqlite");
  hasNodeSqlite = true;
} catch {
  // not available
}

describe.skipIf(!hasNodeSqlite)("parallel sessions e2e (real SQLite)", () => {
  let tmpDir: string;
  let dbPath: string;
  let backend: SharedMemoryBackend;
  let manager: ParallelSessionManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "parallel-sessions-e2e-"));
    dbPath = path.join(tmpDir, "shared-memory.db");
    backend = new SharedMemoryBackend({ dbPath, enableWAL: true });
    await backend.initialize();
  });

  afterEach(async () => {
    await manager?.shutdown();
    await backend?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Lifecycle: create → save → briefing → hibernate → resume ──

  it("full session lifecycle: create, save memory, generate briefing, hibernate, resume", async () => {
    manager = new ParallelSessionManager(
      { enabled: true, maxConcurrent: 5, isolation: "per-channel" },
      backend,
    );

    // 1. Create a session
    const { sessionKey, isNew } = await manager.getOrCreateSession({ channelId: "discord" });
    expect(isNew).toBe(true);
    expect(sessionKey).toBe("agent:main:parallel:discord");

    // 2. Save some memories
    await manager.saveMemory({
      sessionKey,
      channelId: "discord",
      memoryType: "preference",
      content: "User prefers dark mode",
      importance: 6,
    });
    await manager.saveMemory({
      sessionKey,
      channelId: "discord",
      memoryType: "decision",
      content: "Always use TypeScript strict mode",
      importance: 9,
    });
    await manager.saveMemory({
      sessionKey,
      channelId: "discord",
      memoryType: "fact",
      content: "Project uses vitest for testing",
      importance: 7,
    });

    // 3. Verify memories are persisted in real SQLite
    const dbMemories = await backend.getChannelMemories({ channelId: "discord" });
    expect(dbMemories.length).toBe(3);
    expect(dbMemories.map((m) => m.content)).toContain("User prefers dark mode");

    // 4. Verify auto-promotion to global knowledge (importance >= 8 by default)
    const globalKnowledge = await backend.getGlobalKnowledge();
    expect(globalKnowledge.length).toBe(1);
    expect(globalKnowledge[0].content).toBe("Always use TypeScript strict mode");
    expect(globalKnowledge[0].confidence).toBeCloseTo(0.9);

    // 5. Generate briefing — should include memories and global knowledge from SQLite
    const briefing = await manager.generateBriefing(sessionKey);
    expect(briefing).toContain("Channel Context");
    expect(briefing).toContain("Always use TypeScript strict mode");
    expect(briefing).toContain("Project uses vitest for testing");
    expect(briefing).toContain("User prefers dark mode");

    // 6. Hibernate the session
    await manager.hibernateSession(sessionKey);

    // Verify session state was persisted to SQLite
    const stored = await backend.loadSessionState(sessionKey);
    expect(stored).not.toBeNull();
    expect(stored!.session.channelId).toBe("discord");
    expect(stored!.session.status).toBe("hibernated");

    // 7. Re-access the session — should reactivate from hibernation
    const reactivated = vi.fn();
    manager.on("session:reactivated", reactivated);

    const { isNew: isNew2 } = await manager.getOrCreateSession({ channelId: "discord" });
    expect(isNew2).toBe(false);
    expect(reactivated).toHaveBeenCalledTimes(1);

    // 8. Verify session state was cleaned from persistence store after resume
    const afterResume = await backend.loadSessionState(sessionKey);
    expect(afterResume).toBeNull();
  });

  // ── Cross-session knowledge sharing ──

  it("sessions on different channels share global knowledge", async () => {
    manager = new ParallelSessionManager(
      { enabled: true, maxConcurrent: 5, isolation: "per-channel" },
      backend,
    );

    // Create two sessions on different channels
    const discord = await manager.getOrCreateSession({ channelId: "discord" });
    const telegram = await manager.getOrCreateSession({ channelId: "telegram" });

    // Save a high-importance memory on discord → auto-promotes to global
    await manager.saveMemory({
      sessionKey: discord.sessionKey,
      channelId: "discord",
      memoryType: "decision",
      content: "Team meeting every Monday at 10am",
      importance: 9,
    });

    // The global knowledge should be visible in the telegram session briefing
    const telegramBriefing = await manager.generateBriefing(telegram.sessionKey);
    expect(telegramBriefing).toContain("Global Knowledge");
    expect(telegramBriefing).toContain("Team meeting every Monday at 10am");

    // Verify it's also in the real DB
    const global = await backend.getGlobalKnowledge();
    expect(global.length).toBe(1);
    expect(global[0].sourceChannel).toBe("discord");
  });

  // ── Concurrent session limits with hibernation ──

  it("enforces maxConcurrent by hibernating oldest session to disk", async () => {
    manager = new ParallelSessionManager(
      { enabled: true, maxConcurrent: 2, isolation: "per-channel" },
      backend,
    );

    // Create 2 sessions (at limit)
    await manager.getOrCreateSession({ channelId: "discord" });

    // Small delay to ensure different lastActivityAt
    await new Promise((r) => setTimeout(r, 10));
    await manager.getOrCreateSession({ channelId: "telegram" });

    expect(manager.getActiveSessions().length).toBe(2);

    // 3rd session should hibernate the oldest (discord)
    const hibernated = vi.fn();
    manager.on("session:hibernated", hibernated);

    await manager.getOrCreateSession({ channelId: "slack" });

    expect(hibernated).toHaveBeenCalledTimes(1);
    expect(hibernated.mock.calls[0][0].channelId).toBe("discord");
    expect(manager.getActiveSessions().length).toBe(2);

    // Verify discord session was persisted to disk
    const discordState = await backend.loadSessionState("agent:main:parallel:discord");
    expect(discordState).not.toBeNull();
    expect(discordState!.session.status).toBe("hibernated");

    // Now re-open discord — should resume from disk and hibernate telegram
    await manager.getOrCreateSession({ channelId: "discord" });
    expect(manager.getActiveSessions().length).toBe(2);

    // Verify discord state was cleaned from persistence store
    const afterResume = await backend.loadSessionState("agent:main:parallel:discord");
    expect(afterResume).toBeNull();
  });

  // ── Session isolation levels ──

  it("per-chat isolation creates separate sessions per chat", async () => {
    manager = new ParallelSessionManager(
      { enabled: true, maxConcurrent: 10, isolation: "per-chat" },
      backend,
    );

    const chat1 = await manager.getOrCreateSession({ channelId: "telegram", chatId: "group-a" });
    const chat2 = await manager.getOrCreateSession({ channelId: "telegram", chatId: "group-b" });

    expect(chat1.sessionKey).not.toBe(chat2.sessionKey);
    expect(chat1.sessionKey).toContain("group-a");
    expect(chat2.sessionKey).toContain("group-b");

    // Memories saved to chat1 should still appear in chat2's briefing (channel-scoped via channelId)
    await manager.saveMemory({
      sessionKey: chat1.sessionKey,
      channelId: "telegram",
      memoryType: "fact",
      content: "Chat-A specific context",
      importance: 6,
    });

    const chat2Briefing = await manager.generateBriefing(chat2.sessionKey);
    // This memory IS for the same channel, so it appears due to channelId filter
    expect(chat2Briefing).toContain("Chat-A specific context");
  });

  it("per-peer isolation groups by peer across channels", async () => {
    manager = new ParallelSessionManager(
      { enabled: true, maxConcurrent: 10, isolation: "per-peer" },
      backend,
    );

    const user1Discord = await manager.getOrCreateSession({
      channelId: "discord",
      peerId: "user-42",
    });
    const user1Telegram = await manager.getOrCreateSession({
      channelId: "telegram",
      peerId: "user-42",
    });

    // Same peer → same session key regardless of channel
    expect(user1Discord.sessionKey).toBe(user1Telegram.sessionKey);
    expect(user1Discord.sessionKey).toContain("peer:user-42");
  });

  // ── Auto-promotion with configurable threshold ──

  it("respects custom autoPromoteThreshold from config", async () => {
    manager = new ParallelSessionManager(
      {
        enabled: true,
        maxConcurrent: 5,
        memory: { autoPromoteThreshold: 5, backend: "sqlite", enableWAL: true, defaultTTLMs: 0 },
      },
      backend,
    );

    await manager.getOrCreateSession({ channelId: "discord" });

    // importance=5 should promote with threshold=5
    await manager.saveMemory({
      sessionKey: "agent:main:parallel:discord",
      channelId: "discord",
      memoryType: "fact",
      content: "Low threshold promoted fact",
      importance: 5,
    });

    const global = await backend.getGlobalKnowledge();
    expect(global.length).toBe(1);
    expect(global[0].content).toBe("Low threshold promoted fact");
    expect(global[0].confidence).toBeCloseTo(0.5);
  });

  it("does NOT promote memories below threshold", async () => {
    manager = new ParallelSessionManager(
      { enabled: true, maxConcurrent: 5, isolation: "per-channel" },
      backend,
    );

    await manager.getOrCreateSession({ channelId: "discord" });

    // Default threshold is 8 — importance 7 should NOT promote
    await manager.saveMemory({
      sessionKey: "agent:main:parallel:discord",
      channelId: "discord",
      memoryType: "fact",
      content: "Below threshold fact",
      importance: 7,
    });

    const global = await backend.getGlobalKnowledge();
    expect(global.length).toBe(0);

    // But it should still be in channel memories
    const channel = await backend.getChannelMemories({ channelId: "discord" });
    expect(channel.length).toBe(1);
    expect(channel[0].content).toBe("Below threshold fact");
  });

  // ── Memory search across real SQLite ──

  it("searches memories across channel and global scope in real DB", async () => {
    manager = new ParallelSessionManager(
      { enabled: true, maxConcurrent: 5, isolation: "per-channel" },
      backend,
    );

    await manager.getOrCreateSession({ channelId: "discord" });

    await manager.saveMemory({
      sessionKey: "agent:main:parallel:discord",
      channelId: "discord",
      memoryType: "fact",
      content: "The database uses PostgreSQL in production",
      importance: 6,
    });
    await manager.saveMemory({
      sessionKey: "agent:main:parallel:discord",
      channelId: "discord",
      memoryType: "decision",
      content: "Migrated from MySQL to PostgreSQL last quarter",
      importance: 9,
    });

    // Search via manager (returns SessionMemoryEntry only, filtered by type guard)
    const memResults = await manager.searchMemory("PostgreSQL");
    expect(memResults.length).toBe(2);
    // All results should have sessionKey (SessionMemoryEntry, not GlobalKnowledgeEntry)
    for (const r of memResults) {
      expect("sessionKey" in r).toBe(true);
    }

    // Search in real SQLite backend (returns union type)
    const dbResults = await backend.searchMemories("PostgreSQL");
    expect(dbResults.length).toBeGreaterThanOrEqual(2); // channel + possibly global

    // Search with channel scope only
    const channelOnly = await backend.searchMemories("PostgreSQL", { scope: "channel" });
    expect(channelOnly.length).toBe(2);

    // Search with global scope only
    const globalOnly = await backend.searchMemories("PostgreSQL", { scope: "global" });
    expect(globalOnly.length).toBe(1); // Only the importance=9 one got promoted
    expect(globalOnly[0].content).toContain("Migrated from MySQL");
  });

  // ── Expired memory cleanup ──

  it("cleans up expired memories from real SQLite", async () => {
    manager = new ParallelSessionManager(
      { enabled: true, maxConcurrent: 5, isolation: "per-channel" },
      backend,
    );

    await manager.getOrCreateSession({ channelId: "discord" });

    // Save a memory that's already expired
    await backend.saveChannelMemory({
      sessionKey: "agent:main:parallel:discord",
      channelId: "discord",
      memoryType: "fact",
      content: "Expired fact",
      importance: 5,
      createdAt: Date.now() - 100_000,
      expiresAt: Date.now() - 1000, // expired 1s ago
      promotedToGlobal: false,
    });

    // Save a non-expired memory
    await backend.saveChannelMemory({
      sessionKey: "agent:main:parallel:discord",
      channelId: "discord",
      memoryType: "fact",
      content: "Fresh fact",
      importance: 5,
      createdAt: Date.now(),
      promotedToGlobal: false,
    });

    const beforeCleanup = await backend.getChannelMemories({
      channelId: "discord",
      excludeExpired: false,
    });
    expect(beforeCleanup.length).toBe(2);

    const cleaned = await backend.cleanupExpired();
    expect(cleaned).toBe(1);

    const afterCleanup = await backend.getChannelMemories({ channelId: "discord" });
    expect(afterCleanup.length).toBe(1);
    expect(afterCleanup[0].content).toBe("Fresh fact");
  });

  // ── Stats from real SQLite ──

  it("reports accurate stats from real SQLite tables", async () => {
    manager = new ParallelSessionManager(
      { enabled: true, maxConcurrent: 5, isolation: "per-channel" },
      backend,
    );

    await manager.getOrCreateSession({ channelId: "discord" });

    await manager.saveMemory({
      sessionKey: "agent:main:parallel:discord",
      channelId: "discord",
      memoryType: "fact",
      content: "Fact 1",
      importance: 5,
    });
    await manager.saveMemory({
      sessionKey: "agent:main:parallel:discord",
      channelId: "discord",
      memoryType: "decision",
      content: "Important decision",
      importance: 9,
    });

    const dbStats = await backend.getStats();
    expect(dbStats.channelMemoryCount).toBe(2);
    expect(dbStats.globalKnowledgeCount).toBe(1); // importance=9 promoted
    expect(dbStats.workItemsActive).toBe(0);
    expect(dbStats.personCount).toBe(0);

    // getStats() is now async
    const managerStats = await manager.getStats();
    expect(managerStats.totalSessions).toBe(1);
    expect(managerStats.activeSessions).toBe(1);
    expect(managerStats.totalMemories).toBe(2);
    expect(managerStats.globalKnowledgeCount).toBe(1);
    expect(managerStats.activeWorkItems).toBe(0);
  });

  // ── Shutdown persists all active sessions ──

  it("shutdown hibernates all active sessions to disk", async () => {
    manager = new ParallelSessionManager(
      { enabled: true, maxConcurrent: 5, isolation: "per-channel" },
      backend,
    );

    await manager.getOrCreateSession({ channelId: "discord" });
    await manager.getOrCreateSession({ channelId: "telegram" });
    await manager.getOrCreateSession({ channelId: "slack" });

    // Save memories on each
    for (const channel of ["discord", "telegram", "slack"]) {
      await manager.saveMemory({
        sessionKey: `agent:main:parallel:${channel}`,
        channelId: channel,
        memoryType: "fact",
        content: `Memory for ${channel}`,
        importance: 6,
      });
    }

    await manager.shutdown();

    // All 3 sessions should be persisted in SQLite
    for (const channel of ["discord", "telegram", "slack"]) {
      const state = await backend.loadSessionState(`agent:main:parallel:${channel}`);
      expect(state).not.toBeNull();
      expect(state!.session.channelId).toBe(channel);
      expect(state!.session.status).toBe("hibernated");
    }

    // Memories should still be in the DB
    const allMemories = await backend.getChannelMemories({});
    expect(allMemories.length).toBe(3);
  });

  // ── Backend survives close + re-open (persistence durability) ──

  it("data survives backend close and re-open (disk persistence)", async () => {
    manager = new ParallelSessionManager(
      { enabled: true, maxConcurrent: 5, isolation: "per-channel" },
      backend,
    );

    await manager.getOrCreateSession({ channelId: "discord" });

    await manager.saveMemory({
      sessionKey: "agent:main:parallel:discord",
      channelId: "discord",
      memoryType: "decision",
      content: "Critical decision that must survive restart",
      importance: 9,
    });

    await manager.hibernateSession("agent:main:parallel:discord");

    // Close everything
    await manager.shutdown();
    await backend.close();

    // Re-open a fresh backend from the same DB file
    const backend2 = new SharedMemoryBackend({ dbPath, enableWAL: true });
    await backend2.initialize();

    // Verify channel memories survived
    const memories = await backend2.getChannelMemories({ channelId: "discord" });
    expect(memories.length).toBe(1);
    expect(memories[0].content).toBe("Critical decision that must survive restart");

    // Verify global knowledge survived
    const global = await backend2.getGlobalKnowledge();
    expect(global.length).toBe(1);
    expect(global[0].content).toBe("Critical decision that must survive restart");

    // Verify session state survived
    const sessionState = await backend2.loadSessionState("agent:main:parallel:discord");
    expect(sessionState).not.toBeNull();
    expect(sessionState!.session.channelId).toBe("discord");

    // Create a fresh manager from the re-opened backend
    const manager2 = new ParallelSessionManager(
      { enabled: true, maxConcurrent: 5, isolation: "per-channel" },
      backend2,
    );

    // Manager starts fresh, so it's a "new" session — but backend has all the data
    const { isNew } = await manager2.getOrCreateSession({ channelId: "discord" });
    expect(isNew).toBe(true);

    // Briefing now comes from SQLite, so it should include the persisted data
    const briefing = await manager2.generateBriefing("agent:main:parallel:discord");
    expect(briefing).toContain("Critical decision that must survive restart");

    await manager2.shutdown();
    await backend2.close();
  });

  // ── WAL mode verification ──

  it("creates the DB file when enableWAL is true", async () => {
    manager = new ParallelSessionManager({ enabled: true }, backend);

    // After initialize + any write, the DB file should exist
    await manager.getOrCreateSession({ channelId: "discord" });
    await manager.saveMemory({
      sessionKey: "agent:main:parallel:discord",
      channelId: "discord",
      memoryType: "fact",
      content: "WAL test",
      importance: 5,
    });

    expect(fs.existsSync(dbPath)).toBe(true);
    // WAL file may or may not exist depending on SQLite checkpoint behavior,
    // but the DB itself should be present and non-empty
    const stat = fs.statSync(dbPath);
    expect(stat.size).toBeGreaterThan(0);
  });

  // ── Idempotent close ──

  it("backend close is idempotent and doesn't throw on double-close", async () => {
    manager = new ParallelSessionManager({ enabled: true }, backend);

    await backend.close();
    await backend.close(); // Should not throw
    await backend.close(); // Still fine
  });

  // ── Error on uninitialized backend ──

  it("backend throws meaningful error when used before initialize", async () => {
    const uninitBackend = new SharedMemoryBackend({ dbPath: path.join(tmpDir, "nope.db") });
    manager = new ParallelSessionManager({ enabled: true });

    await expect(uninitBackend.getChannelMemories({ channelId: "x" })).rejects.toThrow(
      "not initialized",
    );
  });

  // ── SQLite-first: no in-memory arrays ──

  it("memory-free operation: saves go to SQLite, no in-memory arrays", async () => {
    manager = new ParallelSessionManager(
      { enabled: true, maxConcurrent: 5, isolation: "per-channel" },
      backend,
    );

    await manager.getOrCreateSession({ channelId: "discord" });

    // Save many memories
    for (let i = 0; i < 20; i++) {
      await manager.saveMemory({
        sessionKey: "agent:main:parallel:discord",
        channelId: "discord",
        memoryType: "fact",
        content: `Memory #${i}`,
        importance: 5,
      });
    }

    // All should be in SQLite
    const dbMemories = await backend.getChannelMemories({ channelId: "discord", limit: 100 });
    expect(dbMemories.length).toBe(20);

    // getStats comes from backend now
    const stats = await manager.getStats();
    expect(stats.totalMemories).toBe(20);
  });

  // ── Concurrent writes don't corrupt ──

  it("handles concurrent session creation without corruption", async () => {
    manager = new ParallelSessionManager(
      { enabled: true, maxConcurrent: 10, isolation: "per-channel" },
      backend,
    );

    // Create 10 sessions concurrently
    const channels = Array.from({ length: 10 }, (_, i) => `channel-${i}`);
    const results = await Promise.all(
      channels.map((channelId) => manager.getOrCreateSession({ channelId })),
    );

    expect(results.length).toBe(10);
    expect(new Set(results.map((r) => r.sessionKey)).size).toBe(10); // All unique
    expect(results.every((r) => r.isNew)).toBe(true);
    expect(manager.getActiveSessions().length).toBe(10);

    // Save memories concurrently
    await Promise.all(
      channels.map((channelId, i) =>
        manager.saveMemory({
          sessionKey: `agent:main:parallel:${channelId}`,
          channelId,
          memoryType: "fact",
          content: `Concurrent memory ${i}`,
          importance: 5,
        }),
      ),
    );

    const dbMemories = await backend.getChannelMemories({ limit: 100 });
    expect(dbMemories.length).toBe(10);
  });

  // ── Work Item Lifecycle ──

  it("work item full lifecycle: schedule → ready → execute → complete", async () => {
    manager = new ParallelSessionManager(
      { enabled: true, maxConcurrent: 5, isolation: "per-channel" },
      backend,
    );

    await manager.getOrCreateSession({ channelId: "discord" });

    // Schedule work (no scheduledFor = status "ready")
    const workId = await manager.scheduleWork({
      sessionKey: "agent:main:parallel:discord",
      channelId: "discord",
      description: "Research competitor pricing",
      payload: { urls: ["https://example.com"] },
      priority: 7,
    });

    expect(workId).toBeGreaterThan(0);

    // Verify it's stored
    const items = await manager.getWork("agent:main:parallel:discord", ["ready"]);
    expect(items.length).toBe(1);
    expect(items[0].description).toBe("Research competitor pricing");
    expect(items[0].status).toBe("ready");
    expect(items[0].priority).toBe(7);

    // Claim it (simulating executor)
    const claimed = await manager.claimReadyWork(1);
    expect(claimed.length).toBe(1);
    expect(claimed[0].status).toBe("executing");

    // Update progress
    await manager.transitionWork(workId, "executing", { progressPct: 50 });

    // Complete
    await manager.transitionWork(workId, "completed", {
      progressPct: 100,
      resultSummary: "Found 3 competitor prices",
    });

    const completed = await manager.getWork("agent:main:parallel:discord", ["completed"]);
    expect(completed.length).toBe(1);
    expect(completed[0].resultSummary).toBe("Found 3 competitor prices");
  });

  it("work item scheduling with future scheduledFor", async () => {
    manager = new ParallelSessionManager(
      { enabled: true, maxConcurrent: 5, isolation: "per-channel" },
      backend,
    );

    await manager.getOrCreateSession({ channelId: "discord" });

    const futureTime = Date.now() + 60_000;
    await manager.scheduleWork({
      sessionKey: "agent:main:parallel:discord",
      channelId: "discord",
      description: "Future task",
      payload: {},
      scheduledFor: futureTime,
    });

    // Should NOT be claimable yet
    const claimed = await manager.claimReadyWork(1);
    expect(claimed.length).toBe(0);

    // Verify it's stored as scheduled
    const items = await manager.getWork("agent:main:parallel:discord", ["scheduled"]);
    expect(items.length).toBe(1);
    expect(items[0].scheduledFor).toBe(futureTime);
  });

  it("work item cancellation before execution", async () => {
    manager = new ParallelSessionManager(
      { enabled: true, maxConcurrent: 5, isolation: "per-channel" },
      backend,
    );

    await manager.getOrCreateSession({ channelId: "discord" });

    const workId = await manager.scheduleWork({
      sessionKey: "agent:main:parallel:discord",
      channelId: "discord",
      description: "Cancellable task",
      payload: {},
    });

    const cancelled = await manager.cancelWork(workId);
    expect(cancelled).toBe(true);

    const items = await manager.getWork("agent:main:parallel:discord", ["cancelled"]);
    expect(items.length).toBe(1);
  });

  it("work item retry on failure sets back to ready", async () => {
    manager = new ParallelSessionManager(
      { enabled: true, maxConcurrent: 5, isolation: "per-channel" },
      backend,
    );

    await manager.getOrCreateSession({ channelId: "discord" });

    const workId = await manager.scheduleWork({
      sessionKey: "agent:main:parallel:discord",
      channelId: "discord",
      description: "Retryable task",
      payload: {},
      maxAttempts: 3,
    });

    // Claim and simulate first failure
    await manager.claimReadyWork(1);
    await manager.transitionWork(workId, "ready", {
      attempts: 1,
      resultSummary: "Attempt 1 failed: timeout",
    });

    // Should be claimable again
    const items = await manager.getWork("agent:main:parallel:discord", ["ready"]);
    expect(items.length).toBe(1);
    expect(items[0].attempts).toBe(1);
  });

  it("work item final failure after maxAttempts", async () => {
    manager = new ParallelSessionManager(
      { enabled: true, maxConcurrent: 5, isolation: "per-channel" },
      backend,
    );

    await manager.getOrCreateSession({ channelId: "discord" });

    const workId = await manager.scheduleWork({
      sessionKey: "agent:main:parallel:discord",
      channelId: "discord",
      description: "Doomed task",
      payload: {},
      maxAttempts: 2,
    });

    // Simulate 2 failed attempts then mark as final failure
    await manager.claimReadyWork(1);
    await manager.transitionWork(workId, "failed", {
      attempts: 2,
      resultSummary: "Failed after 2 attempts: persistent error",
    });

    const failed = await manager.getWork("agent:main:parallel:discord", ["failed"]);
    expect(failed.length).toBe(1);
    expect(failed[0].resultSummary).toContain("Failed after 2 attempts");
  });

  it("briefing includes active work items from SQLite", async () => {
    manager = new ParallelSessionManager(
      { enabled: true, maxConcurrent: 5, isolation: "per-channel" },
      backend,
    );

    const { sessionKey } = await manager.getOrCreateSession({ channelId: "discord" });

    await manager.scheduleWork({
      sessionKey,
      channelId: "discord",
      description: "Browser automation task",
      payload: {},
      priority: 8,
    });

    const briefing = await manager.generateBriefing(sessionKey);
    expect(briefing).toContain("Active Work");
    expect(briefing).toContain("Browser automation task");
    expect(briefing).toContain("READY");
  });

  it("concurrent sessions + work items share SQLite correctly", async () => {
    manager = new ParallelSessionManager(
      { enabled: true, maxConcurrent: 5, isolation: "per-channel" },
      backend,
    );

    const discord = await manager.getOrCreateSession({ channelId: "discord" });
    const telegram = await manager.getOrCreateSession({ channelId: "telegram" });

    // Schedule work on discord
    await manager.scheduleWork({
      sessionKey: discord.sessionKey,
      channelId: "discord",
      description: "Discord-only work",
      payload: {},
    });

    // Save high-importance memory on discord (promotes to global)
    await manager.saveMemory({
      sessionKey: discord.sessionKey,
      channelId: "discord",
      memoryType: "decision",
      content: "Shared knowledge from discord",
      importance: 9,
    });

    // Telegram should see global knowledge but NOT discord's work
    const telegramBriefing = await manager.generateBriefing(telegram.sessionKey);
    expect(telegramBriefing).toContain("Shared knowledge from discord");
    expect(telegramBriefing).not.toContain("Discord-only work");

    // Discord should see both its work and global knowledge
    const discordBriefing = await manager.generateBriefing(discord.sessionKey);
    expect(discordBriefing).toContain("Discord-only work");
    expect(discordBriefing).toContain("Shared knowledge from discord");
  });

  it("getStats includes work item counts from SQLite", async () => {
    manager = new ParallelSessionManager(
      { enabled: true, maxConcurrent: 5, isolation: "per-channel" },
      backend,
    );

    await manager.getOrCreateSession({ channelId: "discord" });

    // Save 3 work items with different statuses
    const id1 = await manager.scheduleWork({
      sessionKey: "agent:main:parallel:discord",
      channelId: "discord",
      description: "Scheduled work",
      payload: {},
      scheduledFor: Date.now() + 60_000,
    });
    await manager.scheduleWork({
      sessionKey: "agent:main:parallel:discord",
      channelId: "discord",
      description: "Ready work",
      payload: {},
    });

    // Claim the ready one to make it executing
    await manager.claimReadyWork(1);

    // Complete the scheduled one manually
    await manager.transitionWork(id1, "completed", { resultSummary: "Done" });

    const stats = await manager.getStats();
    // 1 executing (claimed), 1 completed (id1) — activeWorkItems should be 1 (executing only)
    expect(stats.activeWorkItems).toBe(1);
  });

  it("work items survive backend close and reopen", async () => {
    manager = new ParallelSessionManager(
      { enabled: true, maxConcurrent: 5, isolation: "per-channel" },
      backend,
    );

    await manager.getOrCreateSession({ channelId: "discord" });

    await manager.scheduleWork({
      sessionKey: "agent:main:parallel:discord",
      channelId: "discord",
      description: "Persistent work item",
      payload: { key: "value", nested: { a: 1 } },
      priority: 8,
    });

    await manager.shutdown();
    await backend.close();

    // Re-open
    const backend2 = new SharedMemoryBackend({ dbPath, enableWAL: true });
    await backend2.initialize();

    const items = await backend2.getWorkItems({
      sessionKey: "agent:main:parallel:discord",
      statuses: ["ready"],
    });
    expect(items.length).toBe(1);
    expect(items[0].description).toBe("Persistent work item");
    expect(items[0].payload).toEqual({ key: "value", nested: { a: 1 } });
    expect(items[0].priority).toBe(8);

    await backend2.close();
  });
});
