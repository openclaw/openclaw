import type { Db, Collection } from "mongodb";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./mongodb-schema.js", () => ({
  chunksCollection: vi.fn(),
  filesCollection: vi.fn(),
  embeddingCacheCollection: vi.fn(),
  kbChunksCollection: vi.fn(),
  structuredMemCollection: vi.fn(),
}));

import { getMemoryStats } from "./mongodb-analytics.js";
import {
  chunksCollection,
  filesCollection,
  embeddingCacheCollection,
  kbChunksCollection,
  structuredMemCollection,
} from "./mongodb-schema.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockCol(overrides: Record<string, unknown> = {}): Collection {
  return {
    aggregate: vi.fn(() => ({
      toArray: vi.fn(async () => []),
    })),
    countDocuments: vi.fn(async () => 0),
    distinct: vi.fn(async () => []),
    ...overrides,
  } as unknown as Collection;
}

let mockChunks: Collection;
let mockFiles: Collection;
let mockCache: Collection;
let mockKbChunks: Collection;
let mockStructuredMem: Collection;
const db = {} as Db;

beforeEach(() => {
  vi.clearAllMocks();
  mockChunks = createMockCol();
  mockFiles = createMockCol();
  mockCache = createMockCol();
  mockKbChunks = createMockCol();
  mockStructuredMem = createMockCol();
  vi.mocked(chunksCollection).mockReturnValue(mockChunks);
  vi.mocked(filesCollection).mockReturnValue(mockFiles);
  vi.mocked(embeddingCacheCollection).mockReturnValue(mockCache);
  vi.mocked(kbChunksCollection).mockReturnValue(mockKbChunks);
  vi.mocked(structuredMemCollection).mockReturnValue(mockStructuredMem);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getMemoryStats", () => {
  it("returns zero stats for empty collections", async () => {
    const stats = await getMemoryStats(db, "test_");

    expect(stats.totalFiles).toBe(0);
    expect(stats.totalChunks).toBe(0);
    expect(stats.cachedEmbeddings).toBe(0);
    expect(stats.sources).toEqual([]);
    expect(stats.staleFiles).toEqual([]);
    expect(stats.embeddingCoverage.coveragePercent).toBe(0);
    expect(stats.embeddingStatusCoverage).toEqual({ total: 0, success: 0, failed: 0, pending: 0 });
    expect(stats.collectionSizes.files).toBe(0);
    expect(stats.collectionSizes.chunks).toBe(0);
    expect(stats.collectionSizes.embeddingCache).toBe(0);
  });

  it("returns per-source breakdown for memory + sessions", async () => {
    // Mock files aggregate: two sources
    (mockFiles.aggregate as ReturnType<typeof vi.fn>).mockReturnValue({
      toArray: vi.fn(async () => [
        { _id: "memory", count: 5, lastSync: new Date("2026-01-01") },
        { _id: "sessions", count: 3, lastSync: new Date("2026-01-02") },
      ]),
    });
    // Mock chunks aggregate for source counts
    (mockChunks.aggregate as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({
        // First call: chunk source agg
        toArray: vi.fn(async () => [
          { _id: "memory", count: 20 },
          { _id: "sessions", count: 10 },
        ]),
      })
      .mockReturnValueOnce({
        // Second call: embedding coverage agg
        toArray: vi.fn(async () => [{ _id: null, withEmbedding: 15, total: 30 }]),
      });
    (mockFiles.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(8);

    const stats = await getMemoryStats(db, "test_");

    expect(stats.sources).toHaveLength(2);
    const memorySrc = stats.sources.find((s) => s.source === "memory");
    expect(memorySrc).toBeDefined();
    expect(memorySrc!.fileCount).toBe(5);
    expect(memorySrc!.chunkCount).toBe(20);
    expect(memorySrc!.lastSync).toEqual(new Date("2026-01-01"));

    const sessionsSrc = stats.sources.find((s) => s.source === "sessions");
    expect(sessionsSrc).toBeDefined();
    expect(sessionsSrc!.fileCount).toBe(3);
    expect(sessionsSrc!.chunkCount).toBe(10);
  });

  it("calculates embedding coverage percentage", async () => {
    (mockFiles.aggregate as ReturnType<typeof vi.fn>).mockReturnValue({
      toArray: vi.fn(async () => []),
    });
    (mockChunks.aggregate as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ toArray: vi.fn(async () => []) })
      .mockReturnValueOnce({
        toArray: vi.fn(async () => [{ _id: null, withEmbedding: 7, total: 10 }]),
      });

    const stats = await getMemoryStats(db, "test_");

    expect(stats.embeddingCoverage.withEmbedding).toBe(7);
    expect(stats.embeddingCoverage.withoutEmbedding).toBe(3);
    expect(stats.embeddingCoverage.total).toBe(10);
    expect(stats.embeddingCoverage.coveragePercent).toBe(70);
  });

  it("detects stale files when validPaths is provided", async () => {
    (mockFiles.aggregate as ReturnType<typeof vi.fn>).mockReturnValue({
      toArray: vi.fn(async () => []),
    });
    (mockChunks.aggregate as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ toArray: vi.fn(async () => []) })
      .mockReturnValueOnce({ toArray: vi.fn(async () => []) });
    (mockFiles.distinct as ReturnType<typeof vi.fn>).mockResolvedValue([
      "memory/keep.md",
      "memory/stale.md",
      "sessions/old.jsonl",
    ]);

    const validPaths = new Set(["memory/keep.md"]);
    const stats = await getMemoryStats(db, "test_", validPaths);

    expect(stats.staleFiles).toEqual(["memory/stale.md", "sessions/old.jsonl"]);
  });

  it("skips stale detection when no validPaths provided", async () => {
    (mockFiles.aggregate as ReturnType<typeof vi.fn>).mockReturnValue({
      toArray: vi.fn(async () => []),
    });
    (mockChunks.aggregate as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ toArray: vi.fn(async () => []) })
      .mockReturnValueOnce({ toArray: vi.fn(async () => []) });

    const stats = await getMemoryStats(db, "test_");

    expect(stats.staleFiles).toEqual([]);
    expect(mockFiles.distinct).not.toHaveBeenCalled();
  });

  it("aggregates embeddingStatusCoverage across all chunk collections", async () => {
    (mockFiles.aggregate as ReturnType<typeof vi.fn>).mockReturnValue({
      toArray: vi.fn(async () => []),
    });
    (mockChunks.aggregate as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ toArray: vi.fn(async () => []) }) // source agg
      .mockReturnValueOnce({ toArray: vi.fn(async () => []) }) // embedding agg
      .mockReturnValueOnce({
        toArray: vi.fn(async () => [
          { _id: "success", count: 10 },
          { _id: "failed", count: 2 },
          { _id: "pending", count: 3 },
        ]),
      }); // status agg for chunks
    // kb_chunks status agg
    (mockKbChunks.aggregate as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      toArray: vi.fn(async () => [
        { _id: "success", count: 5 },
        { _id: "failed", count: 1 },
      ]),
    });
    // structured_mem status agg
    (mockStructuredMem.aggregate as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      toArray: vi.fn(async () => [{ _id: "success", count: 4 }]),
    });

    const stats = await getMemoryStats(db, "test_");

    // Totals: chunks(10+2+3=15) + kb(5+1=6) + structured(4) = 25
    expect(stats.embeddingStatusCoverage.total).toBe(25);
    expect(stats.embeddingStatusCoverage.success).toBe(19); // 10+5+4
    expect(stats.embeddingStatusCoverage.failed).toBe(3); // 2+1
    expect(stats.embeddingStatusCoverage.pending).toBe(3);
  });

  it("treats missing embeddingStatus as pending in coverage", async () => {
    (mockFiles.aggregate as ReturnType<typeof vi.fn>).mockReturnValue({
      toArray: vi.fn(async () => []),
    });
    (mockChunks.aggregate as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ toArray: vi.fn(async () => []) })
      .mockReturnValueOnce({ toArray: vi.fn(async () => []) })
      .mockReturnValueOnce({
        // $ifNull maps null embeddingStatus to "pending"
        toArray: vi.fn(async () => [{ _id: "pending", count: 8 }]),
      });
    (mockKbChunks.aggregate as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      toArray: vi.fn(async () => []),
    });
    (mockStructuredMem.aggregate as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      toArray: vi.fn(async () => []),
    });

    const stats = await getMemoryStats(db, "test_");

    expect(stats.embeddingStatusCoverage.pending).toBe(8);
    expect(stats.embeddingStatusCoverage.success).toBe(0);
    expect(stats.embeddingStatusCoverage.failed).toBe(0);
  });

  it("counts cached embeddings", async () => {
    (mockFiles.aggregate as ReturnType<typeof vi.fn>).mockReturnValue({
      toArray: vi.fn(async () => []),
    });
    (mockChunks.aggregate as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ toArray: vi.fn(async () => []) })
      .mockReturnValueOnce({ toArray: vi.fn(async () => []) });
    (mockCache.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(42);

    const stats = await getMemoryStats(db, "test_");

    expect(stats.cachedEmbeddings).toBe(42);
    expect(stats.collectionSizes.embeddingCache).toBe(42);
  });
});
