import { describe, expect, it, vi, beforeEach } from "vitest";
import { ParallelSessionManager } from "./parallel-session-manager.js";
import type { SharedMemoryBackend } from "./shared-memory-backend.js";

interface MockBackendSpies {
  saveChannelMemory: ReturnType<typeof vi.fn>;
  saveGlobalKnowledge: ReturnType<typeof vi.fn>;
  saveSessionState: ReturnType<typeof vi.fn>;
  loadSessionState: ReturnType<typeof vi.fn>;
  deleteSessionState: ReturnType<typeof vi.fn>;
}

function createMockBackend(): { backend: SharedMemoryBackend; spies: MockBackendSpies } {
  const saveChannelMemory = vi.fn().mockResolvedValue(1);
  const saveGlobalKnowledge = vi.fn().mockResolvedValue(1);
  const saveSessionState = vi.fn().mockResolvedValue(undefined);
  const loadSessionState = vi.fn().mockResolvedValue(null);
  const deleteSessionState = vi.fn().mockResolvedValue(undefined);

  const backend = {
    initialize: vi.fn(),
    saveChannelMemory,
    getChannelMemories: vi.fn().mockResolvedValue([]),
    saveGlobalKnowledge,
    getGlobalKnowledge: vi.fn().mockResolvedValue([]),
    searchMemories: vi.fn().mockResolvedValue([]),
    saveSessionState,
    loadSessionState,
    deleteSessionState,
    getStats: vi
      .fn()
      .mockResolvedValue({
        channelMemoryCount: 0,
        globalKnowledgeCount: 0,
        actionItemsOpen: 0,
        personCount: 0,
      }),
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

    it("persists hibernated session to backend", async () => {
      await manager.getOrCreateSession({ channelId: "discord" });
      await manager.getOrCreateSession({ channelId: "slack" });
      await manager.getOrCreateSession({ channelId: "telegram" });

      await manager.getOrCreateSession({ channelId: "whatsapp" });
      expect(spies.saveSessionState).toHaveBeenCalled();
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

  describe("memory save and auto-promotion", () => {
    it("saves memory and persists to backend", async () => {
      await manager.getOrCreateSession({ channelId: "discord" });
      await manager.saveMemory({
        sessionKey: "agent:main:parallel:discord",
        channelId: "discord",
        memoryType: "fact",
        content: "user prefers dark mode",
        importance: 5,
      });
      expect(spies.saveChannelMemory).toHaveBeenCalledTimes(1);
      expect(manager.getStats().totalMemories).toBe(1);
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
    it("includes channel memories and global knowledge", async () => {
      const { sessionKey } = await manager.getOrCreateSession({ channelId: "discord" });

      await manager.saveMemory({
        sessionKey,
        channelId: "discord",
        memoryType: "fact",
        content: "user likes TypeScript",
        importance: 7,
      });

      await manager.saveMemory({
        sessionKey,
        channelId: "discord",
        memoryType: "decision",
        content: "always use vitest",
        importance: 9,
      });

      const briefing = await manager.generateBriefing(sessionKey);
      expect(briefing).toContain("Channel Context");
      expect(briefing).toContain("always use vitest");
      expect(briefing).toContain("user likes TypeScript");
    });

    it("returns empty string for unknown session", async () => {
      const briefing = await manager.generateBriefing("nonexistent");
      expect(briefing).toBe("");
    });
  });

  describe("memory search", () => {
    it("filters by query and options", async () => {
      await manager.getOrCreateSession({ channelId: "discord" });
      await manager.saveMemory({
        sessionKey: "agent:main:parallel:discord",
        channelId: "discord",
        memoryType: "fact",
        content: "user prefers dark mode",
        importance: 5,
      });
      await manager.saveMemory({
        sessionKey: "agent:main:parallel:discord",
        channelId: "discord",
        memoryType: "decision",
        content: "use light theme for docs",
        importance: 6,
      });

      const results = await manager.searchMemory("dark");
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("user prefers dark mode");
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
    it("returns correct counts", async () => {
      await manager.getOrCreateSession({ channelId: "discord" });
      await manager.getOrCreateSession({ channelId: "slack" });
      await manager.saveMemory({
        sessionKey: "agent:main:parallel:discord",
        channelId: "discord",
        memoryType: "fact",
        content: "test",
        importance: 5,
      });

      const stats = manager.getStats();
      expect(stats.totalSessions).toBe(2);
      expect(stats.activeSessions).toBe(2);
      expect(stats.hibernatedSessions).toBe(0);
      expect(stats.totalMemories).toBe(1);
    });
  });
});
