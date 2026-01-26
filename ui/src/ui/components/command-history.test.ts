import { afterEach, describe, expect, it } from "vitest";
import {
  clearCommandHistory,
  getRecentCommandIds,
  MAX_HISTORY,
  recordCommandUsage,
} from "./command-history";

describe("command-history", () => {
  afterEach(() => {
    clearCommandHistory();
  });

  // ---------------------------------------------------------------------------
  // recordCommandUsage + getRecentCommandIds
  // ---------------------------------------------------------------------------
  describe("recordCommandUsage", () => {
    it("records a command id", () => {
      recordCommandUsage("nav-chat");
      expect(getRecentCommandIds()).toEqual(["nav-chat"]);
    });

    it("places the most recent command first", () => {
      recordCommandUsage("nav-chat");
      recordCommandUsage("nav-config");
      expect(getRecentCommandIds()).toEqual(["nav-config", "nav-chat"]);
    });

    it("deduplicates repeated commands and moves them to front", () => {
      recordCommandUsage("a");
      recordCommandUsage("b");
      recordCommandUsage("c");
      recordCommandUsage("a"); // re-used
      expect(getRecentCommandIds()).toEqual(["a", "c", "b"]);
    });

    it(`caps history at ${MAX_HISTORY} entries`, () => {
      for (let i = 0; i < MAX_HISTORY + 5; i++) {
        recordCommandUsage(`cmd-${i}`);
      }
      const ids = getRecentCommandIds();
      expect(ids).toHaveLength(MAX_HISTORY);
      // The most recent should be last recorded
      expect(ids[0]).toBe(`cmd-${MAX_HISTORY + 4}`);
    });

    it("persists across reads (localStorage)", () => {
      recordCommandUsage("x");
      recordCommandUsage("y");
      // Simulate a fresh read by calling getRecentCommandIds again
      const ids = getRecentCommandIds();
      expect(ids).toEqual(["y", "x"]);
    });
  });

  // ---------------------------------------------------------------------------
  // getRecentCommandIds
  // ---------------------------------------------------------------------------
  describe("getRecentCommandIds", () => {
    it("returns empty array when no history exists", () => {
      expect(getRecentCommandIds()).toEqual([]);
    });

    it("respects the limit parameter", () => {
      recordCommandUsage("a");
      recordCommandUsage("b");
      recordCommandUsage("c");
      expect(getRecentCommandIds(2)).toEqual(["c", "b"]);
    });

    it("returns all entries when limit exceeds history length", () => {
      recordCommandUsage("a");
      const ids = getRecentCommandIds(100);
      expect(ids).toEqual(["a"]);
    });
  });

  // ---------------------------------------------------------------------------
  // clearCommandHistory
  // ---------------------------------------------------------------------------
  describe("clearCommandHistory", () => {
    it("empties the history", () => {
      recordCommandUsage("a");
      recordCommandUsage("b");
      clearCommandHistory();
      expect(getRecentCommandIds()).toEqual([]);
    });

    it("is safe to call when history is already empty", () => {
      clearCommandHistory();
      expect(getRecentCommandIds()).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Resilience
  // ---------------------------------------------------------------------------
  describe("resilience", () => {
    it("recovers from corrupted localStorage data", () => {
      localStorage.setItem("clawdbot:command-history", "not-json!!!");
      expect(getRecentCommandIds()).toEqual([]);
      // Should still work after corruption
      recordCommandUsage("a");
      expect(getRecentCommandIds()).toEqual(["a"]);
    });

    it("recovers from non-array localStorage data", () => {
      localStorage.setItem("clawdbot:command-history", JSON.stringify({ foo: "bar" }));
      expect(getRecentCommandIds()).toEqual([]);
    });

    it("filters out non-string entries", () => {
      localStorage.setItem("clawdbot:command-history", JSON.stringify(["a", 42, null, "b"]));
      expect(getRecentCommandIds()).toEqual(["a", "b"]);
    });
  });
});
