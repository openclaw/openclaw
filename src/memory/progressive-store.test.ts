import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProgressiveMemoryStore } from "./progressive-store.js";

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prog-mem-test-"));
  return path.join(dir, "progressive.db");
}

function cleanupDb(dbPath: string): void {
  try {
    const dir = path.dirname(dbPath);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe("ProgressiveMemoryStore", () => {
  let store: ProgressiveMemoryStore;
  let dbPath: string;

  afterEach(() => {
    store?.close();
    if (dbPath) cleanupDb(dbPath);
  });

  function createStore(opts?: { dedupThreshold?: number }) {
    dbPath = tmpDbPath();
    store = new ProgressiveMemoryStore({
      dbPath,
      dims: 3, // Small dims for testing
      dedupThreshold: opts?.dedupThreshold ?? 0.92,
    });
    return store;
  }

  describe("store and retrieve", () => {
    it("stores a basic entry and retrieves by ID", async () => {
      createStore();
      const result = await store.store({
        category: "fact",
        content: "David lives in Colorado",
        context: "Mentioned during introductions",
        priority: "high",
        tags: ["geography", "personal"],
      });

      expect(result.stored).toBe(true);
      expect(result.deduplicated).toBe(false);
      expect(result.category).toBe("fact");
      expect(result.id).toBeTruthy();
      expect(result.tokenCost).toBeGreaterThan(0);

      const entry = store.getById(result.id);
      expect(entry).not.toBeNull();
      expect(entry!.content).toBe("David lives in Colorado");
      expect(entry!.context).toBe("Mentioned during introductions");
      expect(entry!.priority).toBe("high");
      expect(entry!.tags).toEqual(["geography", "personal"]);
      expect(entry!.archived).toBe(false);
      expect(entry!.createdAt).toBeTruthy();
      expect(entry!.updatedAt).toBeTruthy();
    });

    it("uses default priority and source", async () => {
      createStore();
      const result = await store.store({
        category: "preference",
        content: "Prefers dark mode",
      });

      const entry = store.getById(result.id);
      expect(entry!.priority).toBe("medium");
      expect(entry!.source).toBe("manual");
      expect(entry!.tags).toEqual([]);
      expect(entry!.relatedTo).toEqual([]);
    });

    it("stores with expires date", async () => {
      createStore();
      const future = new Date(Date.now() + 86400000).toISOString();
      const result = await store.store({
        category: "fact",
        content: "Temp fact",
        expires: future,
      });

      const entry = store.getById(result.id);
      expect(entry!.expiresAt).toBe(future);
    });
  });

  describe("validation", () => {
    it("rejects invalid category", async () => {
      createStore();
      await expect(
        store.store({
          category: "invalid" as any,
          content: "test",
        }),
      ).rejects.toThrow(/Invalid category/);
    });

    it("rejects empty content", async () => {
      createStore();
      await expect(
        store.store({
          category: "fact",
          content: "",
        }),
      ).rejects.toThrow(/Content is required/);
    });

    it("rejects invalid priority", async () => {
      createStore();
      await expect(
        store.store({
          category: "fact",
          content: "test",
          priority: "ultra" as any,
        }),
      ).rejects.toThrow(/Invalid priority/);
    });

    it("rejects invalid expires date", async () => {
      createStore();
      await expect(
        store.store({
          category: "fact",
          content: "test",
          expires: "not-a-date",
        }),
      ).rejects.toThrow(/Invalid expires date/);
    });
  });

  describe("list", () => {
    it("lists entries with category filter", async () => {
      createStore();
      await store.store({ category: "fact", content: "Fact 1" });
      await store.store({ category: "preference", content: "Pref 1" });
      await store.store({ category: "fact", content: "Fact 2" });

      const facts = store.list({ categories: ["fact"] });
      expect(facts).toHaveLength(2);
      expect(facts.every((e) => e.category === "fact")).toBe(true);

      const prefs = store.list({ categories: ["preference"] });
      expect(prefs).toHaveLength(1);
    });

    it("lists entries with priority filter", async () => {
      createStore();
      await store.store({ category: "fact", content: "Low", priority: "low" });
      await store.store({ category: "fact", content: "High", priority: "high" });
      await store.store({ category: "fact", content: "Critical", priority: "critical" });

      const highAndAbove = store.list({ priorityMin: "high" });
      expect(highAndAbove).toHaveLength(2);
      expect(highAndAbove.every((e) => e.priority === "high" || e.priority === "critical")).toBe(
        true,
      );
    });

    it("excludes archived by default", async () => {
      createStore();
      const result = await store.store({ category: "fact", content: "Will archive" });
      await store.store({ category: "fact", content: "Will keep" });

      store.archive(result.id);

      const entries = store.list();
      expect(entries).toHaveLength(1);
      expect(entries[0].content).toBe("Will keep");
    });

    it("includes archived when requested", async () => {
      createStore();
      const result = await store.store({ category: "fact", content: "Archived" });
      await store.store({ category: "fact", content: "Active" });
      store.archive(result.id);

      const all = store.list({ archived: true });
      expect(all).toHaveLength(1);
      expect(all[0].archived).toBe(true);
    });

    it("supports pagination", async () => {
      createStore();
      for (let i = 0; i < 5; i++) {
        await store.store({ category: "fact", content: `Entry ${i}` });
      }

      const page1 = store.list({ limit: 2, offset: 0 });
      expect(page1).toHaveLength(2);

      const page2 = store.list({ limit: 2, offset: 2 });
      expect(page2).toHaveLength(2);

      const page3 = store.list({ limit: 2, offset: 4 });
      expect(page3).toHaveLength(1);
    });
  });

  describe("FTS search", () => {
    it("finds entries by text content", async () => {
      createStore();
      await store.store({ category: "fact", content: "David lives in Colorado" });
      await store.store({ category: "fact", content: "The sky is blue" });

      const results = store.searchFts("Colorado");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toContain("Colorado");
      expect(results[0].score).toBeGreaterThan(0);
    });

    it("filters FTS by category", async () => {
      createStore();
      await store.store({ category: "fact", content: "Colorado fact" });
      await store.store({ category: "preference", content: "Colorado preference" });

      const results = store.searchFts("Colorado", { categories: ["preference"] });
      expect(results).toHaveLength(1);
      expect(results[0].category).toBe("preference");
    });

    it("returns empty for no match", async () => {
      createStore();
      await store.store({ category: "fact", content: "Hello world" });

      const results = store.searchFts("xyznonexistent");
      expect(results).toHaveLength(0);
    });
  });

  describe("archive and delete", () => {
    it("archives an entry", async () => {
      createStore();
      const result = await store.store({ category: "fact", content: "To archive" });

      const success = store.archive(result.id);
      expect(success).toBe(true);

      const entry = store.getById(result.id);
      expect(entry!.archived).toBe(true);
    });

    it("archive returns false for non-existent ID", () => {
      createStore();
      const success = store.archive("non-existent-id");
      expect(success).toBe(false);
    });

    it("deletes an entry permanently", async () => {
      createStore();
      const result = await store.store({ category: "fact", content: "To delete" });

      const success = store.delete(result.id);
      expect(success).toBe(true);

      const entry = store.getById(result.id);
      expect(entry).toBeNull();
    });

    it("archives expired entries", async () => {
      createStore();
      const past = new Date(Date.now() - 86400000).toISOString();
      const future = new Date(Date.now() + 86400000).toISOString();

      await store.store({ category: "fact", content: "Expired", expires: past });
      await store.store({ category: "fact", content: "Not expired", expires: future });
      await store.store({ category: "fact", content: "No expiry" });

      const archived = store.archiveExpired();
      expect(archived).toBe(1);

      const entries = store.list();
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.content !== "Expired")).toBe(true);
    });
  });

  describe("status", () => {
    it("returns accurate counts", async () => {
      createStore();
      await store.store({ category: "fact", content: "Fact 1", priority: "high" });
      await store.store({ category: "fact", content: "Fact 2", priority: "low" });
      await store.store({ category: "preference", content: "Pref 1", priority: "high" });

      const status = store.status();
      expect(status.totalEntries).toBe(3);
      expect(status.byCategory.fact).toBe(2);
      expect(status.byCategory.preference).toBe(1);
      expect(status.byPriority.high).toBe(2);
      expect(status.byPriority.low).toBe(1);
      expect(status.totalTokensEstimated).toBeGreaterThan(0);
      expect(status.dbPath).toBe(dbPath);
      expect(status.ftsEnabled).toBe(true);
      expect(status.lastStore).toBeTruthy();
    });
  });

  describe("close safety", () => {
    it("throws after close", async () => {
      createStore();
      store.close();

      expect(() => store.getById("test")).toThrow(/closed/);
      await expect(store.store({ category: "fact", content: "test" })).rejects.toThrow(/closed/);
    });

    it("close is idempotent", () => {
      createStore();
      store.close();
      store.close(); // Should not throw
    });
  });

  describe("persistence", () => {
    it("data survives close and reopen", async () => {
      createStore();
      await store.store({
        category: "fact",
        content: "Persisted across restarts",
        priority: "critical",
        tags: ["persistence"],
      });
      store.close();

      // Reopen the same DB
      store = new ProgressiveMemoryStore({ dbPath, dims: 3 });
      const entries = store.list();
      expect(entries).toHaveLength(1);
      expect(entries[0].content).toBe("Persisted across restarts");
      expect(entries[0].priority).toBe("critical");
      expect(entries[0].tags).toEqual(["persistence"]);
    });
  });

  describe("getById edge cases", () => {
    it("returns null for non-existent ID", () => {
      createStore();
      expect(store.getById("does-not-exist")).toBeNull();
    });
  });

  describe("all categories", () => {
    it("accepts all seven valid categories", async () => {
      createStore();
      const categories = [
        "preference",
        "instruction",
        "fact",
        "project",
        "person",
        "decision",
        "insight",
      ] as const;

      for (const cat of categories) {
        const result = await store.store({ category: cat, content: `Entry for ${cat}` });
        expect(result.stored).toBe(true);
        expect(result.category).toBe(cat);
      }

      const entries = store.list();
      expect(entries).toHaveLength(7);
    });
  });

  describe("unicode and special content", () => {
    it("stores and retrieves unicode content", async () => {
      createStore();
      const content = "日本語テスト 🎉 café naïve résumé";
      const result = await store.store({ category: "fact", content });
      const entry = store.getById(result.id);
      expect(entry!.content).toBe(content);
    });

    it("handles very long content", async () => {
      createStore();
      const content = "A".repeat(100_000);
      const result = await store.store({ category: "fact", content });
      expect(result.stored).toBe(true);
      expect(result.tokenCost).toBe(25_000); // 100000/4
    });
  });

  describe("hybrid search without vector", () => {
    it("performs hybrid search using FTS only", async () => {
      createStore();
      await store.store({ category: "fact", content: "OpenClaw is an agent platform" });
      await store.store({ category: "preference", content: "Prefers dark mode editors" });

      const results = await store.searchHybrid("agent platform", undefined, {
        categories: ["fact"],
      });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toContain("agent");
    });
  });

  describe("archiveExpired idempotency", () => {
    it("does not double-archive", async () => {
      createStore();
      const past = new Date(Date.now() - 86400000).toISOString();
      await store.store({ category: "fact", content: "Expired", expires: past });

      expect(store.archiveExpired()).toBe(1);
      expect(store.archiveExpired()).toBe(0); // already archived
    });
  });

  describe("token estimation", () => {
    it("estimates tokens for content", async () => {
      createStore();
      const result = await store.store({
        category: "fact",
        content: "A".repeat(400), // ~100 tokens
      });

      expect(result.tokenCost).toBe(100); // 400 chars / 4 chars per token
    });

    it("includes context in token estimate", async () => {
      createStore();
      const result = await store.store({
        category: "fact",
        content: "A".repeat(200),
        context: "B".repeat(200),
      });

      expect(result.tokenCost).toBe(100); // (200 + 200) / 4
    });
  });
});
