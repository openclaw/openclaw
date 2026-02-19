import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { incrementAccessCount } from "./manager-search.js";
import { applyTemporalDecayToHybridResults } from "./temporal-decay.js";

describe("Memory Importance Scoring", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: false,
    });
  });

  afterEach(() => {
    db.close();
  });

  describe("incrementAccessCount", () => {
    it("should increment access_count for specified chunks", () => {
      db.exec(`
        INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at, access_count)
        VALUES 
          ('chunk1', 'test.md', 'memory', 1, 10, 'abc', 'model', 'text1', '[0,0,0]', 1700000000000, 0),
          ('chunk2', 'test.md', 'memory', 11, 20, 'def', 'model', 'text2', '[0,0,0]', 1700000000000, 5)
      `);

      incrementAccessCount({ db, chunkIds: ["chunk1", "chunk2"] });

      const rows = db.prepare("SELECT id, access_count FROM chunks ORDER BY id").all() as Array<{
        id: string;
        access_count: number;
      }>;

      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.id === "chunk1")?.access_count).toBe(1);
      expect(rows.find((r) => r.id === "chunk2")?.access_count).toBe(6);
    });

    it("should handle empty chunkIds array", () => {
      db.exec(`
        INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at, access_count)
        VALUES ('chunk1', 'test.md', 'memory', 1, 10, 'abc', 'model', 'text1', '[0,0,0]', 1700000000000, 0)
      `);

      incrementAccessCount({ db, chunkIds: [] });

      const row = db.prepare("SELECT access_count FROM chunks WHERE id = 'chunk1'").get() as {
        access_count: number;
      };

      expect(row.access_count).toBe(0);
    });
  });

  describe("applyTemporalDecayToHybridResults with accessCount", () => {
    const nowMs = Date.now();

    it("should apply importance weighting (accessCount only test)", async () => {
      const results = [
        {
          path: "memory/2025-01-01.md",
          startLine: 1,
          endLine: 10,
          score: 0.7,
          snippet: "popular content",
          source: "memory" as const,
          accessCount: 100,
        },
        {
          path: "memory/2025-01-02.md",
          startLine: 1,
          endLine: 10,
          score: 0.9,
          snippet: "less popular",
          source: "memory" as const,
          accessCount: 0,
        },
      ];

      const decayed = await applyTemporalDecayToHybridResults({
        results,
        temporalDecay: { enabled: true, halfLifeDays: 30 },
        nowMs,
      });

      const popular = decayed.find(
        (r): r is typeof decayed[number] => r.path === "memory/2025-01-01.md",
      );
      const lessPopular = decayed.find(
        (r): r is typeof decayed[number] => r.path === "memory/2025-01-02.md",
      );

      expect(popular).toBeDefined();
      expect(lessPopular).toBeDefined();

      if (popular && lessPopular) {
        expect(popular.score).toBeGreaterThan(lessPopular.score);
      }

      const sorted = [...decayed].toSorted((a, b) => b.score - a.score);
      expect(sorted[0].path).toBe("memory/2025-01-01.md");
    });

    it("should handle missing accessCount (default to 0)", async () => {
      const results = [
        {
          path: "memory/test.md",
          startLine: 1,
          endLine: 10,
          score: 0.8,
          snippet: "test",
          source: "memory" as const,
          _timestamp: new Date(nowMs - 1000),
        },
      ];

      const decayed = await applyTemporalDecayToHybridResults({
        results,
        temporalDecay: { enabled: true, halfLifeDays: 30 },
        nowMs,
      });

      expect(decayed[0].score).toBeCloseTo(0.8, 2);
    });

    it("should preserve original order when temporalDecay is disabled", async () => {
      const results = [
        {
          path: "memory/1.md",
          startLine: 1,
          endLine: 10,
          score: 0.9,
          snippet: "first",
          source: "memory" as const,
          accessCount: 100,
          _timestamp: new Date(nowMs - 1000),
        },
        {
          path: "memory/2.md",
          startLine: 1,
          endLine: 10,
          score: 0.5,
          snippet: "second",
          source: "memory" as const,
          accessCount: 0,
          _timestamp: new Date(nowMs - 1000),
        },
      ];

      const decayed = await applyTemporalDecayToHybridResults({
        results,
        temporalDecay: { enabled: false },
        nowMs,
      });

      expect(decayed[0].path).toBe("memory/1.md");
      expect(decayed[1].path).toBe("memory/2.md");
    });
  });
});
