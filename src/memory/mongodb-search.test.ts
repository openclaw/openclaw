import type { Collection, Document } from "mongodb";
import { describe, it, expect, vi } from "vitest";
import type { DetectedCapabilities } from "./mongodb-schema.js";
import {
  vectorSearch,
  keywordSearch,
  hybridSearchJSFallback,
  mongoSearch,
} from "./mongodb-search.js";

// ---------------------------------------------------------------------------
// Mock collection factory
// ---------------------------------------------------------------------------

function mockCollectionWithResults(results: Document[]): Collection {
  return {
    aggregate: vi.fn(() => ({
      toArray: vi.fn(async () => results),
    })),
    find: vi.fn(() => ({
      sort: vi.fn(() => ({
        limit: vi.fn(() => ({
          toArray: vi.fn(async () => results),
        })),
      })),
    })),
  } as unknown as Collection;
}

function mockCollectionThatFails(error: string): Collection {
  return {
    aggregate: vi.fn(() => ({
      toArray: vi.fn(async () => {
        throw new Error(error);
      }),
    })),
    find: vi.fn(() => ({
      sort: vi.fn(() => ({
        limit: vi.fn(() => ({
          toArray: vi.fn(async () => {
            throw new Error(error);
          }),
        })),
      })),
    })),
  } as unknown as Collection;
}

const SAMPLE_DOCS: Document[] = [
  {
    path: "memory/test.md",
    startLine: 1,
    endLine: 10,
    text: "hello world test content",
    source: "memory",
    score: 0.95,
  },
  {
    path: "memory/other.md",
    startLine: 5,
    endLine: 15,
    text: "another test document",
    source: "memory",
    score: 0.8,
  },
];

const FULL_CAPS: DetectedCapabilities = {
  vectorSearch: true,
  textSearch: true,
  scoreFusion: true,
  rankFusion: true,
};

const NO_CAPS: DetectedCapabilities = {
  vectorSearch: false,
  textSearch: false,
  scoreFusion: false,
  rankFusion: false,
};

// ---------------------------------------------------------------------------
// vectorSearch
// ---------------------------------------------------------------------------

describe("vectorSearch", () => {
  it("builds correct pipeline for managed mode", async () => {
    const col = mockCollectionWithResults(SAMPLE_DOCS);
    const queryVector = [0.1, 0.2, 0.3];
    const results = await vectorSearch(col, queryVector, {
      maxResults: 10,
      minScore: 0.1,
      indexName: "test_vector",
      embeddingMode: "managed",
    });

    expect(col.aggregate).toHaveBeenCalledTimes(1);
    const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const vsStage = pipeline[0].$vectorSearch;
    expect(vsStage.index).toBe("test_vector");
    expect(vsStage.queryVector).toEqual(queryVector);
    expect(vsStage.path).toBe("embedding");
    expect(vsStage.query).toBeUndefined();
    expect(vsStage.numCandidates).toBeGreaterThanOrEqual(100);
    expect(vsStage.limit).toBe(10);
    expect(results).toHaveLength(2);
  });

  it("builds correct pipeline for automated mode", async () => {
    const col = mockCollectionWithResults(SAMPLE_DOCS);
    const results = await vectorSearch(col, null, {
      maxResults: 10,
      minScore: 0.1,
      indexName: "test_vector",
      queryText: "search query",
      embeddingMode: "automated",
    });

    const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const vsStage = pipeline[0].$vectorSearch;
    expect(vsStage.query).toEqual({ text: "search query" });
    expect(vsStage.path).toBe("text");
    expect(vsStage.queryVector).toBeUndefined();
    expect(results).toHaveLength(2);
  });

  it("returns empty array when no queryVector in managed mode", async () => {
    const col = mockCollectionWithResults(SAMPLE_DOCS);
    const results = await vectorSearch(col, null, {
      maxResults: 10,
      minScore: 0.1,
      indexName: "test_vector",
      embeddingMode: "managed",
    });

    expect(col.aggregate).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it("filters results below minScore", async () => {
    const col = mockCollectionWithResults([
      { path: "a.md", startLine: 1, endLine: 2, text: "t", source: "memory", score: 0.9 },
      { path: "b.md", startLine: 1, endLine: 2, text: "t", source: "memory", score: 0.05 },
    ]);
    const results = await vectorSearch(col, [0.1], {
      maxResults: 10,
      minScore: 0.1,
      indexName: "idx",
      embeddingMode: "managed",
    });
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("a.md");
  });

  it("applies session filter", async () => {
    const col = mockCollectionWithResults(SAMPLE_DOCS);
    await vectorSearch(col, [0.1], {
      maxResults: 10,
      minScore: 0.1,
      indexName: "idx",
      sessionKey: "__memory__",
      embeddingMode: "managed",
    });

    const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const vsStage = pipeline[0].$vectorSearch;
    expect(vsStage.filter).toEqual({ source: "memory" });
  });

  it("caps numCandidates at 10000 when maxResults would exceed it", async () => {
    const col = mockCollectionWithResults(SAMPLE_DOCS);
    await vectorSearch(col, [0.1, 0.2], {
      maxResults: 600, // 600 * 20 = 12000 > 10000
      minScore: 0,
      indexName: "test_vector",
      embeddingMode: "managed",
    });

    const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const vsStage = pipeline[0].$vectorSearch;
    expect(vsStage.numCandidates).toBeLessThanOrEqual(10000);
    expect(vsStage.numCandidates).toBe(10000);
  });

  it("caps explicit numCandidates at 10000", async () => {
    const col = mockCollectionWithResults(SAMPLE_DOCS);
    await vectorSearch(col, [0.1, 0.2], {
      maxResults: 10,
      minScore: 0,
      indexName: "test_vector",
      embeddingMode: "managed",
      numCandidates: 15000,
    });

    const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const vsStage = pipeline[0].$vectorSearch;
    expect(vsStage.numCandidates).toBe(10000);
  });

  it("includes $limit after $vectorSearch", async () => {
    const col = mockCollectionWithResults(SAMPLE_DOCS);
    await vectorSearch(col, [0.1], {
      maxResults: 5,
      minScore: 0,
      indexName: "idx",
      embeddingMode: "managed",
    });

    const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Pipeline: $vectorSearch, $limit, $project
    expect(pipeline[1].$limit).toBe(5);
  });

  it("includes $project with vectorSearchScore meta", async () => {
    const col = mockCollectionWithResults(SAMPLE_DOCS);
    await vectorSearch(col, [0.1], {
      maxResults: 10,
      minScore: 0.1,
      indexName: "idx",
      embeddingMode: "managed",
    });

    const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Pipeline: $vectorSearch, $limit, $project
    const projectStage = pipeline[2].$project;
    expect(projectStage.score).toEqual({ $meta: "vectorSearchScore" });
    expect(projectStage._id).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// keywordSearch
// ---------------------------------------------------------------------------

describe("keywordSearch", () => {
  it("builds $search pipeline with compound query", async () => {
    const col = mockCollectionWithResults(SAMPLE_DOCS);
    const results = await keywordSearch(col, "hello world", {
      maxResults: 10,
      minScore: 0.1,
      indexName: "test_text",
    });

    const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const searchStage = pipeline[0].$search;
    expect(searchStage.index).toBe("test_text");
    expect(searchStage.compound.must[0].text.query).toBe("hello world");
    expect(searchStage.compound.must[0].text.path).toBe("text");
    expect(results).toHaveLength(2);
  });

  it("applies session filter as equals clause", async () => {
    const col = mockCollectionWithResults(SAMPLE_DOCS);
    await keywordSearch(col, "test", {
      maxResults: 5,
      minScore: 0,
      indexName: "idx",
      sessionKey: "session-123",
    });

    const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const searchStage = pipeline[0].$search;
    expect(searchStage.compound.filter).toEqual([
      { equals: { path: "source", value: "sessions" } },
    ]);
  });

  it("includes searchScore meta in $project", async () => {
    const col = mockCollectionWithResults(SAMPLE_DOCS);
    await keywordSearch(col, "test", {
      maxResults: 5,
      minScore: 0,
      indexName: "idx",
    });

    const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const projectStage = pipeline[2].$project;
    expect(projectStage.score).toEqual({ $meta: "searchScore" });
  });
});

// ---------------------------------------------------------------------------
// hybridSearchJSFallback
// ---------------------------------------------------------------------------

describe("hybridSearchJSFallback", () => {
  it("merges vector and keyword results with weights", () => {
    const vecResults = [
      {
        path: "a.md",
        startLine: 1,
        endLine: 2,
        score: 0.9,
        snippet: "vec",
        source: "memory" as const,
      },
    ];
    const kwResults = [
      {
        path: "b.md",
        startLine: 3,
        endLine: 4,
        score: 0.8,
        snippet: "kw",
        source: "memory" as const,
      },
    ];

    const merged = hybridSearchJSFallback(vecResults, kwResults, {
      maxResults: 10,
      vectorWeight: 0.7,
      textWeight: 0.3,
    });

    expect(merged.length).toBeGreaterThanOrEqual(2);
  });

  it("respects maxResults limit", () => {
    const vecResults = Array.from({ length: 20 }, (_, i) => ({
      path: `v${i}.md`,
      startLine: 1,
      endLine: 2,
      score: 0.9 - i * 0.01,
      snippet: "t",
      source: "memory" as const,
    }));

    const merged = hybridSearchJSFallback(vecResults, [], {
      maxResults: 5,
      vectorWeight: 1,
      textWeight: 0,
    });

    expect(merged).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// mongoSearch (dispatcher)
// ---------------------------------------------------------------------------

describe("mongoSearch dispatcher", () => {
  const baseOpts = {
    maxResults: 10,
    minScore: 0.1,
    fusionMethod: "scoreFusion" as const,
    vectorIndexName: "chunks_vector",
    textIndexName: "chunks_text",
    vectorWeight: 0.7,
    textWeight: 0.3,
  };

  it("uses $scoreFusion when fusionMethod=scoreFusion and capability available", async () => {
    const col = mockCollectionWithResults(SAMPLE_DOCS);
    await mongoSearch(col, "test query", [0.1, 0.2], {
      ...baseOpts,
      fusionMethod: "scoreFusion",
      capabilities: FULL_CAPS,
      embeddingMode: "managed",
    });

    const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pipeline[0].$scoreFusion).toBeDefined();
  });

  it("uses $rankFusion when fusionMethod=rankFusion (skips $scoreFusion)", async () => {
    const col = mockCollectionWithResults(SAMPLE_DOCS);
    await mongoSearch(col, "test query", [0.1, 0.2], {
      ...baseOpts,
      fusionMethod: "rankFusion",
      capabilities: FULL_CAPS,
      embeddingMode: "managed",
    });

    const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Should use $rankFusion directly, NOT $scoreFusion
    expect(pipeline[0].$rankFusion).toBeDefined();
    expect(pipeline[0].$scoreFusion).toBeUndefined();
  });

  it("falls back from $scoreFusion to $rankFusion on error", async () => {
    let callCount = 0;
    const col = {
      aggregate: vi.fn(() => ({
        toArray: vi.fn(async () => {
          callCount++;
          if (callCount === 1) {
            throw new Error("$scoreFusion failed");
          }
          return SAMPLE_DOCS;
        }),
      })),
      find: vi.fn(() => ({
        sort: vi.fn(() => ({
          limit: vi.fn(() => ({
            toArray: vi.fn(async () => SAMPLE_DOCS),
          })),
        })),
      })),
    } as unknown as Collection;

    const results = await mongoSearch(col, "test query", [0.1, 0.2], {
      ...baseOpts,
      fusionMethod: "scoreFusion",
      capabilities: FULL_CAPS,
      embeddingMode: "managed",
    });

    // Should have retried with $rankFusion
    expect(col.aggregate).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
  });

  it("skips server-side fusion for js-merge fusionMethod", async () => {
    // When fusionMethod is js-merge, should run separate vector + keyword queries
    const col = mockCollectionWithResults(SAMPLE_DOCS);
    await mongoSearch(col, "test query", [0.1, 0.2], {
      ...baseOpts,
      fusionMethod: "js-merge",
      capabilities: FULL_CAPS,
      embeddingMode: "managed",
    });

    // aggregate should be called twice: once for vector, once for keyword
    expect(col.aggregate).toHaveBeenCalledTimes(2);
    const firstPipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const secondPipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock.calls[1][0];
    // Neither should be $scoreFusion or $rankFusion
    expect(firstPipeline[0].$scoreFusion).toBeUndefined();
    expect(firstPipeline[0].$rankFusion).toBeUndefined();
    expect(secondPipeline[0].$scoreFusion).toBeUndefined();
    expect(secondPipeline[0].$rankFusion).toBeUndefined();
  });

  it("falls back to vector-only when textSearch is not available", async () => {
    const col = mockCollectionWithResults(SAMPLE_DOCS);
    await mongoSearch(col, "test", [0.1], {
      ...baseOpts,
      capabilities: { ...FULL_CAPS, textSearch: false, scoreFusion: false, rankFusion: false },
      embeddingMode: "managed",
    });

    const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pipeline[0].$vectorSearch).toBeDefined();
  });

  it("falls back to keyword-only when vectorSearch not available (managed, no queryVector)", async () => {
    const col = mockCollectionWithResults(SAMPLE_DOCS);
    await mongoSearch(col, "test", null, {
      ...baseOpts,
      capabilities: { ...FULL_CAPS, vectorSearch: false },
      embeddingMode: "managed",
    });

    const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pipeline[0].$search).toBeDefined();
  });

  it("falls back to $text search when all Atlas Search methods fail", async () => {
    // With NO_CAPS, dispatcher skips Atlas Search and goes directly to $text fallback
    const col = mockCollectionWithResults(SAMPLE_DOCS);

    await mongoSearch(col, "test", null, {
      ...baseOpts,
      capabilities: NO_CAPS,
      embeddingMode: "managed",
    });

    // Should have used aggregate with $text $match
    expect(col.aggregate).toHaveBeenCalled();
    const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pipeline[0].$match.$text).toBeDefined();
    expect(pipeline[0].$match.$text.$search).toBe("test");
  });

  it("returns empty when everything fails", async () => {
    const col = mockCollectionThatFails("total failure");

    const results = await mongoSearch(col, "test", null, {
      ...baseOpts,
      capabilities: NO_CAPS,
      embeddingMode: "managed",
    });

    expect(results).toEqual([]);
  });

  it("enables vector search in automated mode without queryVector", async () => {
    const col = mockCollectionWithResults(SAMPLE_DOCS);
    await mongoSearch(col, "test query", null, {
      ...baseOpts,
      capabilities: FULL_CAPS,
      embeddingMode: "automated",
    });

    // In automated mode, vector search works without queryVector
    const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Should attempt hybrid search (scoreFusion) with automated embedding
    expect(pipeline[0].$scoreFusion).toBeDefined();
  });

  it("disables vector search in automated mode when capability is false", async () => {
    const col = mockCollectionWithResults(SAMPLE_DOCS);
    await mongoSearch(col, "test query", null, {
      ...baseOpts,
      capabilities: { ...NO_CAPS, textSearch: true },
      embeddingMode: "automated",
    });

    // Without vectorSearch capability, should fall back to keyword only
    const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pipeline[0].$search).toBeDefined();
    expect(pipeline[0].$vectorSearch).toBeUndefined();
    expect(pipeline[0].$scoreFusion).toBeUndefined();
  });
});
