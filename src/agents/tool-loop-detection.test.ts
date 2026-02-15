import { describe, expect, it } from "vitest";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import {
  CRITICAL_THRESHOLD,
  TOOL_CALL_HISTORY_SIZE,
  WARNING_THRESHOLD,
  detectToolCallLoop,
  getToolCallStats,
  hashToolCall,
  recordToolCall,
} from "./tool-loop-detection.js";

describe("tool-loop-detection", () => {
  describe("hashToolCall", () => {
    it("creates consistent hash for same tool and params", () => {
      const hash1 = hashToolCall("read", { path: "/file.txt" });
      const hash2 = hashToolCall("read", { path: "/file.txt" });
      expect(hash1).toBe(hash2);
    });

    it("creates different hashes for different params", () => {
      const hash1 = hashToolCall("read", { path: "/file1.txt" });
      const hash2 = hashToolCall("read", { path: "/file2.txt" });
      expect(hash1).not.toBe(hash2);
    });

    it("creates different hashes for different tools", () => {
      const hash1 = hashToolCall("read", { path: "/file.txt" });
      const hash2 = hashToolCall("write", { path: "/file.txt" });
      expect(hash1).not.toBe(hash2);
    });

    it("handles non-object params", () => {
      expect(() => hashToolCall("tool", "string-param")).not.toThrow();
      expect(() => hashToolCall("tool", 123)).not.toThrow();
      expect(() => hashToolCall("tool", null)).not.toThrow();
    });

    it("produces deterministic hashes regardless of key order", () => {
      const hash1 = hashToolCall("tool", { a: 1, b: 2 });
      const hash2 = hashToolCall("tool", { b: 2, a: 1 });
      expect(hash1).toBe(hash2);
    });
  });

  describe("recordToolCall", () => {
    it("adds tool call to empty history", () => {
      const state: SessionState = {
        lastActivity: Date.now(),
        state: "processing",
        queueDepth: 0,
      };

      recordToolCall(state, "read", { path: "/file.txt" });

      expect(state.toolCallHistory).toHaveLength(1);
      expect(state.toolCallHistory?.[0]?.toolName).toBe("read");
    });

    it("maintains sliding window of last N calls", () => {
      const state: SessionState = {
        lastActivity: Date.now(),
        state: "processing",
        queueDepth: 0,
      };

      // Record more than TOOL_CALL_HISTORY_SIZE calls
      for (let i = 0; i < TOOL_CALL_HISTORY_SIZE + 10; i++) {
        recordToolCall(state, "tool", { iteration: i });
      }

      expect(state.toolCallHistory).toHaveLength(TOOL_CALL_HISTORY_SIZE);

      // Oldest calls should be removed
      const oldestCall = state.toolCallHistory?.[0];
      expect(oldestCall?.argsHash).toContain("iteration");
      expect(oldestCall?.argsHash).not.toContain('"iteration":0'); // Call 0 should be evicted
    });

    it("records timestamp for each call", () => {
      const state: SessionState = {
        lastActivity: Date.now(),
        state: "processing",
        queueDepth: 0,
      };

      const before = Date.now();
      recordToolCall(state, "tool", { arg: 1 });
      const after = Date.now();

      const timestamp = state.toolCallHistory?.[0]?.timestamp ?? 0;
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe("detectToolCallLoop", () => {
    it("does not flag unique tool calls", () => {
      const state: SessionState = {
        lastActivity: Date.now(),
        state: "processing",
        queueDepth: 0,
      };

      // Record 15 unique calls
      for (let i = 0; i < 15; i++) {
        recordToolCall(state, "read", { path: `/file${i}.txt` });
      }

      const result = detectToolCallLoop(state, "read", { path: "/new-file.txt" });
      expect(result.stuck).toBe(false);
    });

    it("returns warning after WARNING_THRESHOLD identical calls", () => {
      const state: SessionState = {
        lastActivity: Date.now(),
        state: "processing",
        queueDepth: 0,
      };

      // Record WARNING_THRESHOLD identical calls
      for (let i = 0; i < WARNING_THRESHOLD; i++) {
        recordToolCall(state, "command_status", { commandId: "cmd-123" });
      }

      const result = detectToolCallLoop(state, "command_status", { commandId: "cmd-123" });

      expect(result.stuck).toBe(true);
      if (result.stuck) {
        expect(result.level).toBe("warning");
        expect(result.message).toContain("WARNING");
        expect(result.message).toContain("10 times");
      }
    });

    it("returns critical after CRITICAL_THRESHOLD identical calls", () => {
      const state: SessionState = {
        lastActivity: Date.now(),
        state: "processing",
        queueDepth: 0,
      };

      // Record CRITICAL_THRESHOLD identical calls
      for (let i = 0; i < CRITICAL_THRESHOLD; i++) {
        recordToolCall(state, "command_status", { commandId: "cmd-123" });
      }

      const result = detectToolCallLoop(state, "command_status", { commandId: "cmd-123" });

      expect(result.stuck).toBe(true);
      if (result.stuck) {
        expect(result.level).toBe("critical");
        expect(result.message).toContain("CRITICAL");
        expect(result.message).toContain("20 times");
      }
    });

    it("only counts identical tool+params combinations", () => {
      const state: SessionState = {
        lastActivity: Date.now(),
        state: "processing",
        queueDepth: 0,
      };

      // Mix different calls - only 5 identical calls for cmd-123
      for (let i = 0; i < 5; i++) {
        recordToolCall(state, "command_status", { commandId: "cmd-123" });
        recordToolCall(state, "command_status", { commandId: "cmd-456" }); // Different params
        recordToolCall(state, "read", { path: "/file.txt" }); // Different tool
      }

      const result = detectToolCallLoop(state, "command_status", { commandId: "cmd-123" });

      // Should be below warning threshold (only 5 cmd-123 calls in history)
      expect(result.stuck).toBe(false);
    });

    it("handles empty history", () => {
      const state: SessionState = {
        lastActivity: Date.now(),
        state: "processing",
        queueDepth: 0,
      };

      const result = detectToolCallLoop(state, "tool", { arg: 1 });
      expect(result.stuck).toBe(false);
    });
  });

  describe("getToolCallStats", () => {
    it("returns zero stats for empty history", () => {
      const state: SessionState = {
        lastActivity: Date.now(),
        state: "processing",
        queueDepth: 0,
      };

      const stats = getToolCallStats(state);
      expect(stats.totalCalls).toBe(0);
      expect(stats.uniquePatterns).toBe(0);
      expect(stats.mostFrequent).toBeNull();
    });

    it("counts total calls and unique patterns", () => {
      const state: SessionState = {
        lastActivity: Date.now(),
        state: "processing",
        queueDepth: 0,
      };

      // Add 5 identical calls
      for (let i = 0; i < 5; i++) {
        recordToolCall(state, "read", { path: "/file.txt" });
      }

      // Add 3 different unique calls
      recordToolCall(state, "write", { path: "/output.txt" });
      recordToolCall(state, "list", { dir: "/home" });
      recordToolCall(state, "read", { path: "/other.txt" });

      const stats = getToolCallStats(state);
      expect(stats.totalCalls).toBe(8);
      expect(stats.uniquePatterns).toBe(4); // read file.txt, write, list, read other.txt
    });

    it("identifies most frequent pattern", () => {
      const state: SessionState = {
        lastActivity: Date.now(),
        state: "processing",
        queueDepth: 0,
      };

      // Pattern 1: 3 calls
      for (let i = 0; i < 3; i++) {
        recordToolCall(state, "read", { path: "/file1.txt" });
      }

      // Pattern 2: 7 calls (most frequent)
      for (let i = 0; i < 7; i++) {
        recordToolCall(state, "read", { path: "/file2.txt" });
      }

      // Pattern 3: 2 calls
      for (let i = 0; i < 2; i++) {
        recordToolCall(state, "write", { path: "/output.txt" });
      }

      const stats = getToolCallStats(state);
      expect(stats.mostFrequent?.toolName).toBe("read");
      expect(stats.mostFrequent?.count).toBe(7);
    });
  });
});
