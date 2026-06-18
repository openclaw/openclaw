import { describe, it, expect } from "vitest";
import { capEntryCount, pruneStaleEntries } from "./store-maintenance";

describe("preserveKeys functionality", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const NOW = Date.now();

  function createStore(entries: Record<string, { updatedAt: number }>) {
    return Object.fromEntries(
      Object.entries(entries).map(([key, value]) => [key, { ...value, threadId: `thread-${key}` }]),
    );
  }

  describe("pruneStaleEntries with preserveKeys", () => {
    it("should preserve sessions in preserveKeys list", () => {
      const store = createStore({
        "agent:ceo:main": { updatedAt: NOW - 2 * DAY_MS },
        "test:session:1": { updatedAt: NOW - 2 * DAY_MS },
        "test:session:2": { updatedAt: NOW - 2 * DAY_MS },
      });

      const preserveKeys = new Set(["agent:ceo:main"]);
      const pruned = pruneStaleEntries(store, DAY_MS, { preserveKeys });

      expect(pruned).toBe(2);
      expect(store["agent:ceo:main"]).toBeDefined();
      expect(store["test:session:1"]).toBeUndefined();
      expect(store["test:session:2"]).toBeUndefined();
    });

    it("should preserve multiple sessions in preserveKeys list", () => {
      const store = createStore({
        "agent:ceo:main": { updatedAt: NOW - 2 * DAY_MS },
        "agent:important": { updatedAt: NOW - 2 * DAY_MS },
        "test:session:1": { updatedAt: NOW - 2 * DAY_MS },
      });

      const preserveKeys = new Set(["agent:ceo:main", "agent:important"]);
      const pruned = pruneStaleEntries(store, DAY_MS, { preserveKeys });

      expect(pruned).toBe(1);
      expect(store["agent:ceo:main"]).toBeDefined();
      expect(store["agent:important"]).toBeDefined();
      expect(store["test:session:1"]).toBeUndefined();
    });

    it("should handle empty preserveKeys set", () => {
      const store = createStore({
        "test:session:1": { updatedAt: NOW - 2 * DAY_MS },
        "test:session:2": { updatedAt: NOW - 2 * DAY_MS },
      });

      const preserveKeys = new Set<string>();
      const pruned = pruneStaleEntries(store, DAY_MS, { preserveKeys });

      expect(pruned).toBe(2);
      expect(store["test:session:1"]).toBeUndefined();
      expect(store["test:session:2"]).toBeUndefined();
    });

    it("should handle undefined preserveKeys", () => {
      const store = createStore({
        "test:session:1": { updatedAt: NOW - 2 * DAY_MS },
        "test:session:2": { updatedAt: NOW - 2 * DAY_MS },
      });

      const pruned = pruneStaleEntries(store, DAY_MS, {});

      expect(pruned).toBe(2);
      expect(store["test:session:1"]).toBeUndefined();
      expect(store["test:session:2"]).toBeUndefined();
    });
  });

  describe("capEntryCount with preserveKeys", () => {
    it("should preserve sessions in preserveKeys list when capping", () => {
      const store = createStore({
        "agent:ceo:main": { updatedAt: NOW },
        "test:session:1": { updatedAt: NOW },
        "test:session:2": { updatedAt: NOW },
        "test:session:3": { updatedAt: NOW },
      });

      const preserveKeys = new Set(["agent:ceo:main"]);
      const capped = capEntryCount(store, 2, { preserveKeys });

      // maxEntries = 2, preservedCount = 1 (agent:ceo:main)
      // maxRemovableEntries = 2 - 1 = 1
      // removable entries = 3 (test:session:1, test:session:2, test:session:3)
      // Since 3 > 1, it will remove 3 - 1 = 2 entries
      expect(capped).toBe(2);
      expect(store["agent:ceo:main"]).toBeDefined();
      expect(store["test:session:1"]).toBeDefined();
      expect(store["test:session:2"]).toBeUndefined();
      expect(store["test:session:3"]).toBeUndefined();
    });

    it("should preserve multiple sessions and cap others", () => {
      const store = createStore({
        "agent:ceo:main": { updatedAt: NOW },
        "agent:important": { updatedAt: NOW },
        "test:session:1": { updatedAt: NOW },
        "test:session:2": { updatedAt: NOW },
        "test:session:3": { updatedAt: NOW },
      });

      const preserveKeys = new Set(["agent:ceo:main", "agent:important"]);
      const capped = capEntryCount(store, 3, { preserveKeys });

      expect(capped).toBe(2);
      expect(store["agent:ceo:main"]).toBeDefined();
      expect(store["agent:important"]).toBeDefined();
      expect(store["test:session:1"]).toBeDefined();
      expect(store["test:session:2"]).toBeUndefined();
      expect(store["test:session:3"]).toBeUndefined();
    });

    it("should not cap if all sessions are preserved", () => {
      const store = createStore({
        "agent:ceo:main": { updatedAt: NOW },
        "agent:important": { updatedAt: NOW },
      });

      const preserveKeys = new Set(["agent:ceo:main", "agent:important"]);
      const capped = capEntryCount(store, 1, { preserveKeys });

      expect(capped).toBe(0);
      expect(store["agent:ceo:main"]).toBeDefined();
      expect(store["agent:important"]).toBeDefined();
    });

    it("should handle empty preserveKeys set", () => {
      const store = createStore({
        "test:session:1": { updatedAt: NOW },
        "test:session:2": { updatedAt: NOW },
        "test:session:3": { updatedAt: NOW },
      });

      const preserveKeys = new Set<string>();
      const capped = capEntryCount(store, 2, { preserveKeys });

      expect(capped).toBe(1);
      expect(Object.keys(store)).toHaveLength(2);
    });
  });

  describe("combined prune and cap with preserveKeys", () => {
    it("should preserve keys through both prune and cap operations", () => {
      const store = createStore({
        "agent:ceo:main": { updatedAt: NOW - 2 * DAY_MS },
        "test:session:1": { updatedAt: NOW - 2 * DAY_MS },
        "test:session:2": { updatedAt: NOW - 2 * DAY_MS },
        "test:session:3": { updatedAt: NOW },
        "test:session:4": { updatedAt: NOW },
      });

      const preserveKeys = new Set(["agent:ceo:main", "test:session:3"]);

      // First prune by age
      const pruned = pruneStaleEntries(store, DAY_MS, { preserveKeys });
      expect(pruned).toBe(2);
      expect(store["agent:ceo:main"]).toBeDefined();
      expect(store["test:session:3"]).toBeDefined();

      // Then cap by count
      // After prune: 3 entries remain (agent:ceo:main, test:session:3, test:session:4)
      // maxEntries = 2, preservedCount = 2 (agent:ceo:main, test:session:3)
      // maxRemovableEntries = 2 - 2 = 0
      // removable entries = 1 (test:session:4)
      // Since 1 > 0, it will remove 1 entry
      const capped = capEntryCount(store, 2, { preserveKeys });
      expect(capped).toBe(1);
      expect(store["agent:ceo:main"]).toBeDefined();
      expect(store["test:session:3"]).toBeDefined();
      expect(store["test:session:4"]).toBeUndefined();
    });
  });
});
