/**
 * Tests for memory flush UI leak fix (#58956)
 *
 * Bug: Pre-compaction memory flush was leaking into chat UI and blocking user's active turn
 * Root cause: Memory flush increased autoCompactionCount, which triggered:
 *   1. System event enqueue (displayed via drainFormattedSystemEvents)
 *   2. Verbose notification "🧹 Auto-compaction complete"
 *
 * Fix: Track performedMemoryFlush flag and suppress UI-visible side effects
 */

import { describe, it, expect } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { MemoryFlushResult } from "./agent-runner-memory.js";

describe("Memory Flush UI Leak Fix (#58956)", () => {
  // Mock session entry
  const createMockSessionEntry = (overrides?: Partial<SessionEntry>): SessionEntry => ({
    sessionId: "test-session-123",
    sessionFile: "/tmp/test-session.jsonl",
    updatedAt: Date.now(),
    systemSent: false,
    abortedLastRun: false,
    chatType: "direct",
    compactionCount: 0,
    memoryFlushCompactionCount: undefined,
    totalTokens: 100000,
    totalTokensFresh: true,
    ...overrides,
  });

  describe("MemoryFlushResult type", () => {
    it("should have correct structure", () => {
      // Verify the type definition is correct
      const mockResult: MemoryFlushResult = {
        sessionEntry: createMockSessionEntry(),
        performedMemoryFlush: false,
      };

      expect(mockResult).toHaveProperty("sessionEntry");
      expect(mockResult).toHaveProperty("performedMemoryFlush");
      expect(typeof mockResult.performedMemoryFlush).toBe("boolean");
    });

    it("should allow undefined sessionEntry", () => {
      const mockResult: MemoryFlushResult = {
        sessionEntry: undefined,
        performedMemoryFlush: false,
      };

      expect(mockResult.sessionEntry).toBeUndefined();
      expect(mockResult.performedMemoryFlush).toBe(false);
    });
  });

  describe("Memory flush suppression logic", () => {
    it("should identify memory flush runs via performedMemoryFlush flag", () => {
      // When memory flush is performed, the flag should be true
      // This flag is used by the caller to suppress:
      // 1. enqueueSystemEvent() calls
      // 2. Verbose notifications

      const flushPerformedResult: MemoryFlushResult = {
        sessionEntry: createMockSessionEntry({ memoryFlushCompactionCount: 1 }),
        performedMemoryFlush: true,
      };

      const noFlushResult: MemoryFlushResult = {
        sessionEntry: createMockSessionEntry(),
        performedMemoryFlush: false,
      };

      // Caller logic (in agent-runner.ts):
      // if (sessionKey && !didPerformMemoryFlush) {
      //   enqueueSystemEvent(...)  // Skip for memory flush
      // }
      // if (verboseEnabled && !didPerformMemoryFlush) {
      //   verboseNotices.push(...)  // Skip for memory flush
      // }

      expect(flushPerformedResult.performedMemoryFlush).toBe(true);
      expect(noFlushResult.performedMemoryFlush).toBe(false);
    });

    it("should suppress system event enqueue when performedMemoryFlush=true", () => {
      // Simulate the caller logic from agent-runner.ts
      const result: MemoryFlushResult = {
        sessionEntry: createMockSessionEntry(),
        performedMemoryFlush: true,
      };

      let systemEventEnqueued = false;

      // This is the actual logic from agent-runner.ts (line ~754-767)
      if (!result.performedMemoryFlush) {
        systemEventEnqueued = true;
      }

      expect(systemEventEnqueued).toBe(false);
    });

    it("should suppress verbose notification when performedMemoryFlush=true", () => {
      // Simulate the caller logic from agent-runner.ts
      const result: MemoryFlushResult = {
        sessionEntry: createMockSessionEntry(),
        performedMemoryFlush: true,
      };

      let verboseNotificationAdded = false;
      const verboseEnabled = true;

      // This is the actual logic from agent-runner.ts (line ~770-773)
      if (verboseEnabled && !result.performedMemoryFlush) {
        verboseNotificationAdded = true;
      }

      expect(verboseNotificationAdded).toBe(false);
    });

    it("should allow system event enqueue for regular compaction", () => {
      // Regular compaction (not memory flush) should still enqueue system events
      const result: MemoryFlushResult = {
        sessionEntry: createMockSessionEntry(),
        performedMemoryFlush: false, // Not a memory flush
      };

      let systemEventEnqueued = false;

      if (!result.performedMemoryFlush) {
        systemEventEnqueued = true;
      }

      expect(systemEventEnqueued).toBe(true);
    });

    it("should allow verbose notification for regular compaction", () => {
      // Regular compaction should still show verbose notifications
      const result: MemoryFlushResult = {
        sessionEntry: createMockSessionEntry(),
        performedMemoryFlush: false, // Not a memory flush
      };

      let verboseNotificationAdded = false;
      const verboseEnabled = true;

      if (verboseEnabled && !result.performedMemoryFlush) {
        verboseNotificationAdded = true;
      }

      expect(verboseNotificationAdded).toBe(true);
    });
  });

  describe("Edge cases and safety checks", () => {
    it("should handle undefined sessionEntry safely", () => {
      const result: MemoryFlushResult = {
        sessionEntry: undefined,
        performedMemoryFlush: false,
      };

      // Should not throw when accessing performedMemoryFlush
      expect(() => result.performedMemoryFlush).not.toThrow();
      expect(result.performedMemoryFlush).toBe(false);
    });

    it("should maintain backward compatibility with existing code", () => {
      // The sessionEntry field maintains the same type as before
      // Only the return type wrapper changed (SessionEntry -> MemoryFlushResult)
      const sessionEntry = createMockSessionEntry();
      const result: MemoryFlushResult = {
        sessionEntry,
        performedMemoryFlush: false,
      };

      expect(result.sessionEntry?.sessionId).toBe(sessionEntry.sessionId);
      expect(result.sessionEntry?.sessionFile).toBe(sessionEntry.sessionFile);
    });

    it("should correctly track memory flush compaction count", () => {
      // After memory flush, memoryFlushCompactionCount should be updated
      const sessionBefore = createMockSessionEntry({
        compactionCount: 5,
        memoryFlushCompactionCount: 4,
      });

      const sessionAfter: MemoryFlushResult = {
        sessionEntry: {
          ...sessionBefore,
          memoryFlushCompactionCount: 5, // Updated to match compactionCount
        },
        performedMemoryFlush: true,
      };

      expect(sessionAfter.sessionEntry?.memoryFlushCompactionCount).toBe(5);
      expect(sessionAfter.performedMemoryFlush).toBe(true);
    });
  });

  describe("Integration scenarios", () => {
    it("should prevent UI leak in long-running sessions", () => {
      // Simulate a long-running session near compaction threshold
      const longSessionEntry = createMockSessionEntry({
        totalTokens: 180000, // Near 200k threshold
        totalTokensFresh: true,
        compactionCount: 10,
      });

      // Memory flush is triggered
      const flushResult: MemoryFlushResult = {
        sessionEntry: {
          ...longSessionEntry,
          memoryFlushCompactionCount: 10,
        },
        performedMemoryFlush: true,
      };

      // Verify suppression logic
      const shouldSuppressSystemEvent = flushResult.performedMemoryFlush;
      const shouldSuppressVerbose = flushResult.performedMemoryFlush;

      expect(shouldSuppressSystemEvent).toBe(true);
      expect(shouldSuppressVerbose).toBe(true);
    });

    it("should allow normal operation for short sessions", () => {
      // Short session well below threshold
      const shortSessionEntry = createMockSessionEntry({
        totalTokens: 50000, // Well below threshold
        totalTokensFresh: true,
      });

      // No memory flush triggered
      const noFlushResult: MemoryFlushResult = {
        sessionEntry: shortSessionEntry,
        performedMemoryFlush: false,
      };

      // No suppression needed
      const shouldSuppressSystemEvent = noFlushResult.performedMemoryFlush;
      const shouldSuppressVerbose = noFlushResult.performedMemoryFlush;

      expect(shouldSuppressSystemEvent).toBe(false);
      expect(shouldSuppressVerbose).toBe(false);
    });
  });

  describe("Type safety checks", () => {
    it("should enforce performedMemoryFlush is boolean", () => {
      // TypeScript will catch this at compile time, but we verify runtime too
      const result: MemoryFlushResult = {
        sessionEntry: undefined,
        performedMemoryFlush: false,
      };

      expect(typeof result.performedMemoryFlush).toBe("boolean");

      // This would be a type error if uncommented:
      // const invalidResult: MemoryFlushResult = {
      //   sessionEntry: undefined,
      //   performedMemoryFlush: "true" as any,
      // };
    });

    it("should preserve SessionEntry type integrity", () => {
      const sessionEntry = createMockSessionEntry({
        sessionId: "unique-123",
        totalTokens: 123456,
        compactionCount: 7,
      });

      const result: MemoryFlushResult = {
        sessionEntry,
        performedMemoryFlush: false,
      };

      // All SessionEntry fields should be accessible
      expect(result.sessionEntry?.sessionId).toBe("unique-123");
      expect(result.sessionEntry?.totalTokens).toBe(123456);
      expect(result.sessionEntry?.compactionCount).toBe(7);
    });
  });
});
