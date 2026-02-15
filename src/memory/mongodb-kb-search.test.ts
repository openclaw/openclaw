import type { Collection, Document } from "mongodb";
import { describe, it, expect, vi } from "vitest";
import type { DetectedCapabilities } from "./mongodb-schema.js";
import { searchKB } from "./mongodb-kb-search.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockKBChunksCol(results: Document[] = []): Collection {
  return {
    aggregate: vi.fn(() => ({
      toArray: vi.fn(async () => results),
    })),
  } as unknown as Collection;
}

const baseCapabilities: DetectedCapabilities = {
  vectorSearch: true,
  textSearch: true,
  scoreFusion: false,
  rankFusion: false,
};

const noSearchCapabilities: DetectedCapabilities = {
  vectorSearch: false,
  textSearch: false,
  scoreFusion: false,
  rankFusion: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("searchKB", () => {
  it("returns results from vector search", async () => {
    const col = mockKBChunksCol([
      {
        path: "guide.md",
        startLine: 1,
        endLine: 10,
        text: "KB content about architecture",
        docId: "doc-1",
        score: 0.85,
      },
    ]);

    const results = await searchKB(col, "architecture", [0.1, 0.2], {
      maxResults: 5,
      minScore: 0.1,
      vectorIndexName: "test_kb_chunks_vector",
      textIndexName: "test_kb_chunks_text",
      capabilities: baseCapabilities,
      embeddingMode: "managed",
    });

    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("kb");
    expect(results[0].score).toBe(0.85);
    expect(results[0].snippet).toContain("KB content about architecture");
  });

  it("returns empty results when no matches", async () => {
    const col = mockKBChunksCol([]);

    const results = await searchKB(col, "nonexistent", [0.1, 0.2], {
      maxResults: 5,
      minScore: 0.1,
      vectorIndexName: "test_kb_chunks_vector",
      textIndexName: "test_kb_chunks_text",
      capabilities: baseCapabilities,
      embeddingMode: "managed",
    });

    expect(results).toHaveLength(0);
  });

  it("filters results below minScore threshold", async () => {
    const col = mockKBChunksCol([
      { path: "low.md", startLine: 1, endLine: 5, text: "Low score content", score: 0.05 },
    ]);

    const results = await searchKB(col, "content", [0.1], {
      maxResults: 5,
      minScore: 0.3,
      vectorIndexName: "test_kb_chunks_vector",
      textIndexName: "test_kb_chunks_text",
      capabilities: baseCapabilities,
      embeddingMode: "managed",
    });

    expect(results).toHaveLength(0);
  });

  it("falls back to $text search when no vector capabilities", async () => {
    const col = mockKBChunksCol([
      { path: "fallback.md", startLine: 1, endLine: 3, text: "Fallback text match", score: 1.5 },
    ]);

    const results = await searchKB(col, "fallback", null, {
      maxResults: 5,
      minScore: 0.1,
      vectorIndexName: "test_kb_chunks_vector",
      textIndexName: "test_kb_chunks_text",
      capabilities: noSearchCapabilities,
      embeddingMode: "managed",
    });

    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("kb");
  });

  it("caps numCandidates at 10000 in KB search (F1)", async () => {
    const col = mockKBChunksCol([
      { path: "a.md", startLine: 1, endLine: 5, text: "content", score: 0.9 },
    ]);

    await searchKB(col, "test", [0.1], {
      maxResults: 5,
      minScore: 0.1,
      vectorIndexName: "idx",
      textIndexName: "txt",
      capabilities: baseCapabilities,
      embeddingMode: "managed",
      numCandidates: 15000,
    });

    const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const vsStage = pipeline[0].$vectorSearch;
    expect(vsStage.numCandidates).toBeLessThanOrEqual(10000);
  });

  it("includes $limit after $vectorSearch in KB search (F7)", async () => {
    const col = mockKBChunksCol([
      { path: "a.md", startLine: 1, endLine: 5, text: "content", score: 0.9 },
    ]);

    await searchKB(col, "test", [0.1], {
      maxResults: 3,
      minScore: 0,
      vectorIndexName: "idx",
      textIndexName: "txt",
      capabilities: baseCapabilities,
      embeddingMode: "managed",
    });

    const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pipeline[1].$limit).toBe(3);
  });

  it("tries hybrid search ($rankFusion) before vector-only when rankFusion available (F12)", async () => {
    const hybridCaps: DetectedCapabilities = {
      ...baseCapabilities,
      rankFusion: true,
    };
    const col = mockKBChunksCol([
      { path: "hybrid.md", startLine: 1, endLine: 5, text: "hybrid result", score: 0.9 },
    ]);

    const results = await searchKB(col, "test", [0.1], {
      maxResults: 5,
      minScore: 0,
      vectorIndexName: "idx",
      textIndexName: "txt",
      capabilities: hybridCaps,
      embeddingMode: "managed",
    });

    expect(results).toHaveLength(1);
    const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pipeline[0].$rankFusion).toBeDefined();
  });

  it("uses automated embedding mode query", async () => {
    const col = mockKBChunksCol([
      { path: "auto.md", startLine: 1, endLine: 5, text: "Auto embed result", score: 0.9 },
    ]);

    const results = await searchKB(col, "auto embed", null, {
      maxResults: 5,
      minScore: 0.1,
      vectorIndexName: "test_kb_chunks_vector",
      textIndexName: "test_kb_chunks_text",
      capabilities: baseCapabilities,
      embeddingMode: "automated",
    });

    expect(results).toHaveLength(1);
    // In automated mode, vector search uses query text instead of queryVector
    const aggregateCalls = (col.aggregate as ReturnType<typeof vi.fn>).mock.calls;
    expect(aggregateCalls.length).toBeGreaterThan(0);
  });
});
