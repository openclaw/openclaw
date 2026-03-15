import { describe, expect, it, vi, beforeEach } from "vitest";
import { ParallelSessionManager } from "./parallel-session-manager.js";
import type { SharedMemoryBackend } from "./shared-memory-backend.js";

interface MockBackendSpies {
  saveChannelMemory: ReturnType<typeof vi.fn>;
  saveGlobalKnowledge: ReturnType<typeof vi.fn>;
  saveSessionState: ReturnType<typeof vi.fn>;
  loadSessionState: ReturnType<typeof vi.fn>;
  deleteSessionState: ReturnType<typeof vi.fn>;
  saveWorkItem: ReturnType<typeof vi.fn>;
  getWorkItems: ReturnType<typeof vi.fn>;
  claimReadyWork: ReturnType<typeof vi.fn>;
  transitionWork: ReturnType<typeof vi.fn>;
  cancelWork: ReturnType<typeof vi.fn>;
  getChannelMemories: ReturnType<typeof vi.fn>;
  getGlobalKnowledge: ReturnType<typeof vi.fn>;
  searchMemories: ReturnType<typeof vi.fn>;
  getStats: ReturnType<typeof vi.fn>;
}

function createMockBackend(): { backend: SharedMemoryBackend; spies: MockBackendSpies } {
  const saveChannelMemory = vi.fn().mockResolvedValue(1);
  const saveGlobalKnowledge = vi.fn().mockResolvedValue(1);
  const saveSessionState = vi.fn().mockResolvedValue(undefined);
  const loadSessionState = vi.fn().mockResolvedValue(null);
  const deleteSessionState = vi.fn().mockResolvedValue(undefined);
  const saveWorkItem = vi.fn().mockResolvedValue(1);
  const getWorkItems = vi.fn().mockResolvedValue([]);
  const claimReadyWork = vi.fn().mockResolvedValue([]);
  const transitionWork = vi.fn().mockResolvedValue(undefined);
  const cancelWork = vi.fn().mockResolvedValue(true);
  const getChannelMemories = vi.fn().mockResolvedValue([]);
  const getGlobalKnowledge = vi.fn().mockResolvedValue([]);
  const searchMemories = vi.fn().mockResolvedValue([]);
  const getStats = vi.fn().mockResolvedValue({
    channelMemoryCount: 0,
    globalKnowledgeCount: 0,
    workItemsActive: 0,
    personCount: 0,
  });

  const backend = {
    initialize: vi.fn(),
    saveChannelMemory,
    getChannelMemories,
    saveGlobalKnowledge,
    getGlobalKnowledge,
    searchMemories,
    saveSessionState,
    loadSessionState,
    deleteSessionState,
    saveWorkItem,
    getWorkItems,
    claimReadyWork,
    transitionWork,
    cancelWork,
    getStats,
    cleanupExpired: vi.fn().mockResolvedValue(0),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as SharedMemoryBackend;

  return {
    backend,
    spies: {
      saveChannelMemory,
      saveGlobalKnowledge,
      saveSessionState,
      loadSessionState,
      deleteSessionState,
      saveWorkItem,
      getWorkItems,
      claimReadyWork,
      transitionWork,
      cancelWork,
      getChannelMemories,
      getGlobalKnowledge,
      searchMemories,
      getStats,
    },
  };
}

describe("ParallelSessionManager", () => {
  let manager: ParallelSessionManager;
  let backend: SharedMemoryBackend;
  let spies: MockBackendSpies;

  beforeEach(() => {
    const mock = createMockBackend();
    backend = mock.backend;
    spies = mock.spies;
    manager = new ParallelSessionManager(
      { enabled: true, maxConcurrent: 3, isolation: "per-channel" },
      backend,
    );
  });

  describe("session key generation", () => {
    it("generates per-channel keys", async () => {
      const result = await manager.getOrCreateSession({ channelId: "discord" });
      expect(result.sessionKey).toBe("agent:main:parallel:discord");
      expect(result.isNew).toBe(true);
    });

    it("generates per-chat keys", async () => {
      const chatManager = new ParallelSessionManager({ isolation: "per-chat" });
      const result = await chatManager.getOrCreateSession({
        channelId: "telegram",
        chatId: "group-123",
      });
      expect(result.sessionKey).toBe("agent:main:parallel:telegram:group-123");
    });

    it("generates per-peer keys", async () => {
      const peerManager = new ParallelSessionManager({ isolation: "per-peer" });
      const result = await peerManager.getOrCreateSession({
        channelId: "slack",
        peerId: "user-42",
      });
      expect(result.sessionKey).toBe("agent:main:parallel:peer:user-42");
    });

    it("uses agentId when provided", async () => {
      const result = await manager.getOrCreateSession({
        channelId: "discord",
        agentId: "bot-1",
      });
      expect(result.sessionKey).toBe("agent:bot-1:parallel:discord");
    });
  });

  describe("concurrent session limit", () => {
    it("hibernates oldest session when limit reached", async () => {
      await manager.getOrCreateSession({ channelId: "discord" });
      await manager.getOrCreateSession({ channelId: "slack" });
      await manager.getOrCreateSession({ channelId: "telegram" });

      // 4th session should trigger hibernation of oldest
      const hibernated = vi.fn();
      manager.on("session:hibernated", hibernated);

      await manager.getOrCreateSession({ channelId: "whatsapp" });
      expect(hibernated).toHaveBeenCalledTimes(1);
      expect(hibernated.mock.calls[0][0].channelId).toBe("discord");
    });

    it("persists hibernated session to backend with correct data", async () => {
      await manager.getOrCreateSession({ channelId: "discord" });
      await manager.getOrCreateSession({ channelId: "slack" });
      await manager.getOrCreateSession({ channelId: "telegram" });

      await manager.getOrCreateSession({ channelId: "whatsapp" });
      expect(spies.saveSessionState).toHaveBeenCalledTimes(1);
      expect(spies.saveSessionState).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:parallel:discord",
          channelId: "discord",
          status: "hibernated",
        }),
      );
    });
  });

  describe("session reuse", () => {
    it("returns existing session on second call", async () => {
      const first = await manager.getOrCreateSession({ channelId: "discord" });
      const second = await manager.getOrCreateSession({ channelId: "discord" });
      expect(second.sessionKey).toBe(first.sessionKey);
      expect(second.isNew).toBe(false);
    });
  });

  describe("session hibernation and resumption", () => {
    it("resumes hibernated session restoring messageCount from backend", async () => {
      // Create session and simulate some messages
      const { sessionKey } = await manager.getOrCreateSession({ channelId: "discord" });

      // Manually hibernate it
      await manager.hibernateSession(sessionKey);

      // Mock backend to return stored state with messageCount
      spies.loadSessionState.mockResolvedValue({
        session: {
          sessionKey,
          channelId: "discord",
          status: "hibernated",
          messageCount: 42,
          createdAt: Date.now() - 10_000,
          lastActivityAt: Date.now(),
        },
        context: null,
      });

      const reactivated = vi.fn();
      manager.on("session:reactivated", reactivated);

      // Re-request the same session — should reactivate from hibernation
      const result = await manager.getOrCreateSession({ channelId: "discord" });
      expect(result.isNew).toBe(false);
      expect(reactivated).toHaveBeenCalledTimes(1);
      expect(spies.loadSessionState).toHaveBeenCalledWith(sessionKey);
      expect(spies.deleteSessionState).toHaveBeenCalledWith(sessionKey);
    });
  });

  describe("memory save and auto-promotion", () => {
    it("saves memory and persists to backend with correct data", async () => {
      await manager.getOrCreateSession({ channelId: "discord" });
      await manager.saveMemory({
        sessionKey: "agent:main:parallel:discord",
        channelId: "discord",
        memoryType: "fact",
        content: "user prefers dark mode",
        importance: 5,
      });
      expect(spies.saveChannelMemory).toHaveBeenCalledTimes(1);
      expect(spies.saveChannelMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:parallel:discord",
          channelId: "discord",
          memoryType: "fact",
          content: "user prefers dark mode",
          importance: 5,
          promotedToGlobal: false,
        }),
      );
    });

    it("auto-promotes high-importance memories using config threshold", async () => {
      // Default threshold is 8
      await manager.getOrCreateSession({ channelId: "discord" });
      const promoted = vi.fn();
      manager.on("knowledge:promoted", promoted);

      // Below threshold — should NOT promote
      await manager.saveMemory({
        sessionKey: "agent:main:parallel:discord",
        channelId: "discord",
        memoryType: "fact",
        content: "casual fact",
        importance: 7,
      });
      expect(promoted).not.toHaveBeenCalled();

      // At threshold — should promote
      await manager.saveMemory({
        sessionKey: "agent:main:parallel:discord",
        channelId: "discord",
        memoryType: "decision",
        content: "critical decision",
        importance: 8,
      });
      expect(promoted).toHaveBeenCalledTimes(1);
      expect(spies.saveGlobalKnowledge).toHaveBeenCalledTimes(1);
    });

    it("respects custom autoPromoteThreshold", async () => {
      const customManager = new ParallelSessionManager(
        { memory: { autoPromoteThreshold: 5 } } as never,
        backend,
      );
      await customManager.getOrCreateSession({ channelId: "discord" });

      const promoted = vi.fn();
      customManager.on("knowledge:promoted", promoted);

      await customManager.saveMemory({
        sessionKey: "agent:main:parallel:discord",
        channelId: "discord",
        memoryType: "fact",
        content: "medium importance fact",
        importance: 5,
      });
      expect(promoted).toHaveBeenCalledTimes(1);
    });
  });

  describe("briefing generation", () => {
    it("includes channel memories and global knowledge from backend", async () => {
      // Mock backend to return memories
      spies.getChannelMemories.mockResolvedValue([
        {
          id: 1,
          sessionKey: "agent:main:parallel:discord",
          channelId: "discord",
          memoryType: "fact",
          content: "user likes TypeScript",
          importance: 7,
          createdAt: Date.now(),
          promotedToGlobal: false,
        },
        {
          id: 2,
          sessionKey: "agent:main:parallel:discord",
          channelId: "discord",
          memoryType: "decision",
          content: "always use vitest",
          importance: 9,
          createdAt: Date.now(),
          promotedToGlobal: true,
        },
      ]);
      spies.getGlobalKnowledge.mockResolvedValue([
        {
          id: 1,
          category: "decision",
          content: "always use vitest",
          sourceChannel: "discord",
          sourceSessionKey: "agent:main:parallel:discord",
          confidence: 0.9,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]);

      const { sessionKey } = await manager.getOrCreateSession({ channelId: "discord" });
      const briefing = await manager.generateBriefing(sessionKey);
      expect(briefing).toContain("Channel Context");
      expect(briefing).toContain("always use vitest");
      expect(briefing).toContain("user likes TypeScript");
      expect(briefing).toContain("Global Knowledge");
    });

    it("includes active work items in briefing", async () => {
      spies.getWorkItems.mockResolvedValue([
        {
          id: 1,
          sessionKey: "agent:main:parallel:discord",
          channelId: "discord",
          description: "Research competitor pricing",
          status: "executing",
          progressPct: 45,
          priority: 7,
          createdAt: Date.now(),
          attempts: 1,
          maxAttempts: 3,
          payload: {},
        },
      ]);

      const { sessionKey } = await manager.getOrCreateSession({ channelId: "discord" });
      const briefing = await manager.generateBriefing(sessionKey);
      expect(briefing).toContain("Active Work");
      expect(briefing).toContain("RUNNING (45%)");
      expect(briefing).toContain("Research competitor pricing");
    });

    it("returns empty string for unknown session", async () => {
      const briefing = await manager.generateBriefing("nonexistent");
      expect(briefing).toBe("");
    });

    it("returns empty without backend", async () => {
      const noBackend = new ParallelSessionManager({ enabled: true });
      await noBackend.getOrCreateSession({ channelId: "discord" });
      const briefing = await noBackend.generateBriefing("agent:main:parallel:discord");
      expect(briefing).toBe("");
    });
  });

  describe("memory search", () => {
    it("delegates to backend searchMemories with correct args", async () => {
      spies.searchMemories.mockResolvedValue([
        {
          id: 1,
          sessionKey: "agent:main:parallel:discord",
          channelId: "discord",
          memoryType: "fact",
          content: "user prefers dark mode",
          importance: 5,
          createdAt: Date.now(),
          promotedToGlobal: false,
        },
      ]);

      const results = await manager.searchMemory("dark", {
        channelId: "discord",
        limit: 5,
      });
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("user prefers dark mode");
      expect(spies.searchMemories).toHaveBeenCalledWith("dark", {
        scope: "channel",
        channelId: "discord",
        limit: 5,
      });
    });

    it("returns only SessionMemoryEntry, not GlobalKnowledgeEntry", async () => {
      // Backend returns mixed union type
      spies.searchMemories.mockResolvedValue([
        {
          id: 1,
          sessionKey: "agent:main:parallel:discord",
          channelId: "discord",
          memoryType: "fact",
          content: "session memory",
          importance: 5,
          createdAt: Date.now(),
          promotedToGlobal: false,
        },
        {
          id: 2,
          category: "decision",
          content: "global entry",
          sourceChannel: "discord",
          sourceSessionKey: "agent:main:parallel:discord",
          confidence: 0.9,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]);

      const results = await manager.searchMemory("test");
      // Only the SessionMemoryEntry should pass the filter
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("session memory");
      expect("sessionKey" in results[0]).toBe(true);
    });

    it("returns empty without backend", async () => {
      const noBackend = new ParallelSessionManager({ enabled: true });
      const results = await noBackend.searchMemory("test");
      expect(results).toHaveLength(0);
    });
  });

  describe("idle check", () => {
    it("marks sessions idle after timeout", async () => {
      vi.useFakeTimers();
      const timerManager = new ParallelSessionManager({ enabled: true, idleTimeoutMs: 60_000 });

      await timerManager.getOrCreateSession({ channelId: "discord" });
      const idled = vi.fn();
      timerManager.on("session:idle", idled);

      // Advance past idle timeout + interval
      vi.advanceTimersByTime(61_000 + 60_000);

      expect(idled).toHaveBeenCalledTimes(1);
      await timerManager.shutdown();
      vi.useRealTimers();
    });
  });

  describe("shutdown", () => {
    it("hibernates all active sessions", async () => {
      await manager.getOrCreateSession({ channelId: "discord" });
      await manager.getOrCreateSession({ channelId: "slack" });

      const hibernated = vi.fn();
      manager.on("session:hibernated", hibernated);
      const shutdown = vi.fn();
      manager.on("shutdown", shutdown);

      await manager.shutdown();
      expect(hibernated).toHaveBeenCalledTimes(2);
      expect(shutdown).toHaveBeenCalledTimes(1);
    });
  });

  describe("getStats", () => {
    it("returns correct counts from backend", async () => {
      spies.getStats.mockResolvedValue({
        channelMemoryCount: 5,
        globalKnowledgeCount: 2,
        workItemsActive: 3,
        personCount: 1,
      });

      await manager.getOrCreateSession({ channelId: "discord" });
      await manager.getOrCreateSession({ channelId: "slack" });

      const stats = await manager.getStats();
      expect(stats.totalSessions).toBe(2);
      expect(stats.activeSessions).toBe(2);
      expect(stats.hibernatedSessions).toBe(0);
      expect(stats.totalMemories).toBe(5);
      expect(stats.globalKnowledgeCount).toBe(2);
      expect(stats.activeWorkItems).toBe(3);
    });

    it("returns zeros without backend", async () => {
      const noBackend = new ParallelSessionManager({ enabled: true });
      const stats = await noBackend.getStats();
      expect(stats.totalMemories).toBe(0);
      expect(stats.globalKnowledgeCount).toBe(0);
      expect(stats.activeWorkItems).toBe(0);
    });
  });

  // ── Work Management API ──

  describe("scheduleWork", () => {
    it("persists to backend with status ready when no scheduledFor", async () => {
      const id = await manager.scheduleWork({
        sessionKey: "agent:main:parallel:discord",
        channelId: "discord",
        description: "Research competitors",
        payload: { url: "https://example.com" },
      });

      expect(id).toBe(1);
      expect(spies.saveWorkItem).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "ready",
          description: "Research competitors",
        }),
      );
    });

    it("sets status to scheduled when scheduledFor is provided", async () => {
      const futureTime = Date.now() + 60_000;
      await manager.scheduleWork({
        sessionKey: "agent:main:parallel:discord",
        channelId: "discord",
        description: "Scheduled task",
        payload: {},
        scheduledFor: futureTime,
      });

      expect(spies.saveWorkItem).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "scheduled",
          scheduledFor: futureTime,
        }),
      );
    });

    it("emits work:scheduled event", async () => {
      const scheduled = vi.fn();
      manager.on("work:scheduled", scheduled);

      await manager.scheduleWork({
        sessionKey: "s",
        channelId: "c",
        description: "d",
        payload: {},
      });

      expect(scheduled).toHaveBeenCalledTimes(1);
    });

    it("throws without backend", async () => {
      const noBackend = new ParallelSessionManager({ enabled: true });
      await expect(
        noBackend.scheduleWork({
          sessionKey: "s",
          channelId: "c",
          description: "d",
          payload: {},
        }),
      ).rejects.toThrow("Backend required");
    });
  });

  describe("cancelWork", () => {
    it("delegates to backend", async () => {
      const result = await manager.cancelWork(42);
      expect(result).toBe(true);
      expect(spies.cancelWork).toHaveBeenCalledWith(42);
    });

    it("emits work:cancelled event on success", async () => {
      const cancelled = vi.fn();
      manager.on("work:cancelled", cancelled);
      await manager.cancelWork(42);
      expect(cancelled).toHaveBeenCalledWith({ id: 42 });
    });

    it("does not emit event when cancel fails", async () => {
      spies.cancelWork.mockResolvedValue(false);
      const cancelled = vi.fn();
      manager.on("work:cancelled", cancelled);
      await manager.cancelWork(99);
      expect(cancelled).not.toHaveBeenCalled();
    });
  });

  describe("getWork", () => {
    it("queries backend by session", async () => {
      await manager.getWork("agent:main:parallel:discord", ["ready"]);
      expect(spies.getWorkItems).toHaveBeenCalledWith({
        sessionKey: "agent:main:parallel:discord",
        statuses: ["ready"],
      });
    });
  });

  describe("claimReadyWork", () => {
    it("delegates to backend.claimReadyWork()", async () => {
      await manager.claimReadyWork(2);
      expect(spies.claimReadyWork).toHaveBeenCalledWith(2);
    });

    it("returns empty without backend", async () => {
      const noBackend = new ParallelSessionManager({ enabled: true });
      const items = await noBackend.claimReadyWork();
      expect(items).toEqual([]);
    });
  });

  describe("transitionWork", () => {
    it("updates backend and emits event", async () => {
      const transitioned = vi.fn();
      manager.on("work:transitioned", transitioned);

      await manager.transitionWork(1, "completed", {
        progressPct: 100,
        resultSummary: "Done",
      });
      expect(spies.transitionWork).toHaveBeenCalledWith(1, "completed", {
        progressPct: 100,
        resultSummary: "Done",
      });
      expect(transitioned).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, status: "completed", progressPct: 100 }),
      );
    });
  });
});
