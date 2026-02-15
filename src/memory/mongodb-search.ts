import type { Collection, Document } from "mongodb";
import type { MemoryMongoDBFusionMethod } from "../config/types.memory.js";
import type { DetectedCapabilities } from "./mongodb-schema.js";
import type { MemorySearchResult, MemorySource } from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { mergeHybridResults, type HybridVectorResult, type HybridKeywordResult } from "./hybrid.js";

const log = createSubsystemLogger("memory:mongodb:search");

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function toSearchResult(doc: Document, source: MemorySource): MemorySearchResult {
  return {
    path: typeof doc.path === "string" ? doc.path : "",
    startLine: typeof doc.startLine === "number" ? doc.startLine : 0,
    endLine: typeof doc.endLine === "number" ? doc.endLine : 0,
    score: typeof doc.score === "number" ? Number(doc.score.toFixed(6)) : 0,
    snippet: typeof doc.text === "string" ? doc.text.slice(0, 700) : "",
    source: (doc.source as MemorySource) ?? source,
  };
}

function filterByScore(results: MemorySearchResult[], minScore: number): MemorySearchResult[] {
  return results.filter((r) => r.score >= minScore);
}

// ---------------------------------------------------------------------------
// $vectorSearch stage builder
// ---------------------------------------------------------------------------
// In automated mode (autoEmbed), MongoDB generates query embeddings from text
// using Voyage AI. Use `query: { text }` and `path` to the source text field.
// In managed mode, the application provides pre-computed embeddings.
// Use `queryVector` and `path` to the embedding field.
// ---------------------------------------------------------------------------

/** Hard maximum for numCandidates — MongoDB server rejects values above 10,000. */
export const MONGODB_MAX_NUM_CANDIDATES = 10_000;

export function buildVectorSearchStage(input: {
  queryVector: number[] | null;
  queryText: string | null;
  embeddingMode: "automated" | "managed";
  indexName: string;
  numCandidates: number;
  limit: number;
  filter?: Document;
  textFieldPath?: string;
}): Document | null {
  const base: Document = {
    index: input.indexName,
    numCandidates: Math.min(input.numCandidates, MONGODB_MAX_NUM_CANDIDATES),
    limit: input.limit,
  };
  if (input.filter && Object.keys(input.filter).length > 0) {
    base.filter = input.filter;
  }

  if (input.embeddingMode === "automated" && input.queryText) {
    // Automated: MongoDB generates the query embedding via Voyage AI
    base.query = { text: input.queryText };
    base.path = input.textFieldPath ?? "text";
  } else if (input.queryVector) {
    // Managed: application provides pre-computed query embedding
    base.queryVector = input.queryVector;
    base.path = "embedding";
  } else {
    return null;
  }

  return base;
}

// ---------------------------------------------------------------------------
// Vector Search (native $vectorSearch)
// ---------------------------------------------------------------------------

export async function vectorSearch(
  collection: Collection,
  queryVector: number[] | null,
  opts: {
    maxResults: number;
    minScore: number;
    sessionKey?: string;
    indexName: string;
    queryText?: string;
    embeddingMode?: "automated" | "managed";
    numCandidates?: number;
  },
): Promise<MemorySearchResult[]> {
  const filter: Document = {};
  if (opts.sessionKey) {
    filter.source = opts.sessionKey === "__memory__" ? "memory" : "sessions";
  }

  const vsStage = buildVectorSearchStage({
    queryVector,
    queryText: opts.queryText ?? null,
    embeddingMode: opts.embeddingMode ?? "managed",
    indexName: opts.indexName,
    numCandidates: opts.numCandidates ?? Math.max(opts.maxResults * 20, 100),
    limit: opts.maxResults,
    filter,
  });

  if (!vsStage) {
    return [];
  }

  const pipeline: Document[] = [
    { $vectorSearch: vsStage },
    { $limit: opts.maxResults },
    {
      $project: {
        _id: 0,
        path: 1,
        startLine: 1,
        endLine: 1,
        text: 1,
        source: 1,
        score: { $meta: "vectorSearchScore" },
      },
    },
  ];

  const docs = await collection.aggregate(pipeline).toArray();
  const results = docs.map((doc) => toSearchResult(doc, "memory"));
  return filterByScore(results, opts.minScore);
}

// ---------------------------------------------------------------------------
// Keyword Search (native $search)
// ---------------------------------------------------------------------------

export async function keywordSearch(
  collection: Collection,
  query: string,
  opts: {
    maxResults: number;
    minScore: number;
    sessionKey?: string;
    indexName: string;
  },
): Promise<MemorySearchResult[]> {
  const filterClauses: Document[] = [];
  if (opts.sessionKey) {
    const source = opts.sessionKey === "__memory__" ? "memory" : "sessions";
    filterClauses.push({ equals: { path: "source", value: source } });
  }

  const pipeline: Document[] = [
    {
      $search: {
        index: opts.indexName,
        compound: {
          must: [{ text: { query, path: "text" } }],
          ...(filterClauses.length > 0 ? { filter: filterClauses } : {}),
        },
      },
    },
    { $limit: opts.maxResults * 4 },
    {
      $project: {
        _id: 0,
        path: 1,
        startLine: 1,
        endLine: 1,
        text: 1,
        source: 1,
        score: { $meta: "searchScore" },
      },
    },
  ];

  const docs = await collection.aggregate(pipeline).toArray();
  const results = docs.map((doc) => toSearchResult(doc, "memory")).slice(0, opts.maxResults);
  return filterByScore(results, opts.minScore);
}

// ---------------------------------------------------------------------------
// Hybrid Search with $scoreFusion (MongoDB 8.2+)
// ---------------------------------------------------------------------------

export async function hybridSearchScoreFusion(
  collection: Collection,
  query: string,
  queryVector: number[] | null,
  opts: {
    maxResults: number;
    minScore: number;
    sessionKey?: string;
    vectorIndexName: string;
    textIndexName: string;
    vectorWeight: number;
    textWeight: number;
    embeddingMode?: "automated" | "managed";
    numCandidates?: number;
  },
): Promise<MemorySearchResult[]> {
  const sourceFilter: Document = {};
  if (opts.sessionKey) {
    sourceFilter.source = opts.sessionKey === "__memory__" ? "memory" : "sessions";
  }

  const textFilterClauses: Document[] = [];
  if (opts.sessionKey) {
    const source = opts.sessionKey === "__memory__" ? "memory" : "sessions";
    textFilterClauses.push({ equals: { path: "source", value: source } });
  }

  const vsStage = buildVectorSearchStage({
    queryVector,
    queryText: query,
    embeddingMode: opts.embeddingMode ?? "managed",
    indexName: opts.vectorIndexName,
    numCandidates: opts.numCandidates ?? Math.max(opts.maxResults * 20, 100),
    limit: opts.maxResults * 4,
    filter: sourceFilter,
  });

  if (!vsStage) {
    return [];
  }

  const pipeline: Document[] = [
    {
      $scoreFusion: {
        input: {
          pipelines: {
            vector: [{ $vectorSearch: vsStage }],
            text: [
              {
                $search: {
                  index: opts.textIndexName,
                  compound: {
                    must: [{ text: { query, path: "text" } }],
                    ...(textFilterClauses.length > 0 ? { filter: textFilterClauses } : {}),
                  },
                },
              },
              { $limit: opts.maxResults * 4 },
            ],
          },
          normalization: "sigmoid",
        },
        combination: {
          weights: {
            vector: opts.vectorWeight,
            text: opts.textWeight,
          },
          method: "avg",
        },
      },
    },
    { $limit: opts.maxResults },
    {
      $project: {
        _id: 0,
        path: 1,
        startLine: 1,
        endLine: 1,
        text: 1,
        source: 1,
        score: { $meta: "searchScore" },
      },
    },
  ];

  const docs = await collection.aggregate(pipeline).toArray();
  const results = docs.map((doc) => toSearchResult(doc, "memory"));
  return filterByScore(results, opts.minScore);
}

// ---------------------------------------------------------------------------
// Hybrid Search with $rankFusion (MongoDB 8.0+)
// ---------------------------------------------------------------------------

export async function hybridSearchRankFusion(
  collection: Collection,
  query: string,
  queryVector: number[] | null,
  opts: {
    maxResults: number;
    minScore: number;
    sessionKey?: string;
    vectorIndexName: string;
    textIndexName: string;
    vectorWeight: number;
    textWeight: number;
    embeddingMode?: "automated" | "managed";
    numCandidates?: number;
  },
): Promise<MemorySearchResult[]> {
  const sourceFilter: Document = {};
  if (opts.sessionKey) {
    sourceFilter.source = opts.sessionKey === "__memory__" ? "memory" : "sessions";
  }

  const textFilterClauses: Document[] = [];
  if (opts.sessionKey) {
    const source = opts.sessionKey === "__memory__" ? "memory" : "sessions";
    textFilterClauses.push({ equals: { path: "source", value: source } });
  }

  const vsStage = buildVectorSearchStage({
    queryVector,
    queryText: query,
    embeddingMode: opts.embeddingMode ?? "managed",
    indexName: opts.vectorIndexName,
    numCandidates: opts.numCandidates ?? Math.max(opts.maxResults * 20, 100),
    limit: opts.maxResults * 4,
    filter: sourceFilter,
  });

  if (!vsStage) {
    return [];
  }

  const pipeline: Document[] = [
    {
      $rankFusion: {
        input: {
          pipelines: {
            vector: [{ $vectorSearch: vsStage }],
            text: [
              {
                $search: {
                  index: opts.textIndexName,
                  compound: {
                    must: [{ text: { query, path: "text" } }],
                    ...(textFilterClauses.length > 0 ? { filter: textFilterClauses } : {}),
                  },
                },
              },
              { $limit: opts.maxResults * 4 },
            ],
          },
        },
        combination: {
          weights: {
            vector: opts.vectorWeight,
            text: opts.textWeight,
          },
        },
      },
    },
    { $limit: opts.maxResults },
    {
      $project: {
        _id: 0,
        path: 1,
        startLine: 1,
        endLine: 1,
        text: 1,
        source: 1,
        score: { $meta: "searchScore" },
      },
    },
  ];

  const docs = await collection.aggregate(pipeline).toArray();
  const results = docs.map((doc) => toSearchResult(doc, "memory"));
  return filterByScore(results, opts.minScore);
}

// ---------------------------------------------------------------------------
// JS fallback merge (for Community without mongot)
// ---------------------------------------------------------------------------

export function hybridSearchJSFallback(
  vectorResults: MemorySearchResult[],
  keywordResults: MemorySearchResult[],
  opts: { maxResults: number; vectorWeight: number; textWeight: number },
): MemorySearchResult[] {
  const vectorHits: HybridVectorResult[] = vectorResults.map((r) => ({
    id: `${r.path}:${r.startLine}:${r.endLine}`,
    path: r.path,
    startLine: r.startLine,
    endLine: r.endLine,
    source: r.source,
    snippet: r.snippet,
    vectorScore: r.score,
  }));

  const keywordHits: HybridKeywordResult[] = keywordResults.map((r) => ({
    id: `${r.path}:${r.startLine}:${r.endLine}`,
    path: r.path,
    startLine: r.startLine,
    endLine: r.endLine,
    source: r.source,
    snippet: r.snippet,
    textScore: r.score,
  }));

  const merged = mergeHybridResults({
    vector: vectorHits,
    keyword: keywordHits,
    vectorWeight: opts.vectorWeight,
    textWeight: opts.textWeight,
  });

  return merged.slice(0, opts.maxResults).map((hit) => ({
    path: hit.path,
    startLine: hit.startLine,
    endLine: hit.endLine,
    score: hit.score,
    snippet: hit.snippet,
    source: hit.source as MemorySource,
  }));
}

// ---------------------------------------------------------------------------
// Main search dispatcher
// ---------------------------------------------------------------------------

export async function mongoSearch(
  collection: Collection,
  query: string,
  queryVector: number[] | null,
  opts: {
    maxResults: number;
    minScore: number;
    numCandidates?: number;
    sessionKey?: string;
    fusionMethod: MemoryMongoDBFusionMethod;
    capabilities: DetectedCapabilities;
    vectorIndexName: string;
    textIndexName: string;
    vectorWeight?: number;
    textWeight?: number;
    embeddingMode?: "automated" | "managed";
  },
): Promise<MemorySearchResult[]> {
  const vectorWeight = opts.vectorWeight ?? 0.7;
  const textWeight = opts.textWeight ?? 0.3;
  const embeddingMode = opts.embeddingMode ?? "managed";

  // In automated mode, MongoDB generates query embeddings via Voyage AI —
  // no queryVector needed from the application. In managed mode, we require
  // a pre-computed queryVector.
  const canVector =
    embeddingMode === "automated"
      ? opts.capabilities.vectorSearch
      : queryVector != null && opts.capabilities.vectorSearch;

  const searchOpts = {
    ...opts,
    vectorWeight,
    textWeight,
    embeddingMode,
  };

  // Attempt hybrid search first (best quality).
  // Respect the user's fusionMethod preference:
  //   "scoreFusion" → try $scoreFusion, fall back to $rankFusion, then JS merge
  //   "rankFusion"  → try $rankFusion directly, fall back to JS merge
  //   "js-merge"    → skip server-side fusion entirely, go straight to JS merge
  if (canVector && opts.capabilities.textSearch) {
    // Try $scoreFusion (only if user wants it and server supports it)
    if (opts.fusionMethod === "scoreFusion" && opts.capabilities.scoreFusion) {
      try {
        return await hybridSearchScoreFusion(collection, query, queryVector, searchOpts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`$scoreFusion failed, trying $rankFusion fallback: ${msg}`);
      }
    }

    // Try $rankFusion (if user wants it, or as fallback from scoreFusion)
    if (opts.fusionMethod !== "js-merge" && opts.capabilities.rankFusion) {
      try {
        return await hybridSearchRankFusion(collection, query, queryVector, searchOpts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`$rankFusion failed, trying separate queries + JS merge: ${msg}`);
      }
    }

    // JS merge fallback: run vector + keyword separately
    try {
      const [vResults, kResults] = await Promise.all([
        vectorSearch(collection, queryVector, {
          ...searchOpts,
          indexName: opts.vectorIndexName,
          queryText: query,
        }),
        keywordSearch(collection, query, { ...searchOpts, indexName: opts.textIndexName }),
      ]);
      return hybridSearchJSFallback(vResults, kResults, {
        maxResults: opts.maxResults,
        vectorWeight,
        textWeight,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`hybrid JS merge failed: ${msg}`);
    }
  }

  // Vector-only fallback
  if (canVector) {
    try {
      return await vectorSearch(collection, queryVector, {
        ...searchOpts,
        indexName: opts.vectorIndexName,
        queryText: query,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`vector search failed: ${msg}`);
    }
  }

  // Keyword-only fallback
  if (opts.capabilities.textSearch) {
    try {
      return await keywordSearch(collection, query, {
        ...searchOpts,
        indexName: opts.textIndexName,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`keyword search failed: ${msg}`);
    }
  }

  // Last resort: basic $text index search (Community without mongot)
  try {
    const filter: Document = { $text: { $search: query } };
    if (opts.sessionKey) {
      filter.source = opts.sessionKey === "__memory__" ? "memory" : "sessions";
    }
    const docs = await collection
      .aggregate([
        { $match: filter },
        {
          $project: {
            _id: 0,
            path: 1,
            startLine: 1,
            endLine: 1,
            text: 1,
            source: 1,
            score: { $meta: "textScore" },
          },
        },
        { $sort: { score: { $meta: "textScore" } } },
        { $limit: opts.maxResults },
      ])
      .toArray();
    return docs
      .map((doc: Document) => toSearchResult(doc, "memory"))
      .filter((r: MemorySearchResult) => r.score >= opts.minScore);
  } catch {
    log.warn("$text search fallback also failed; returning empty results");
    return [];
  }
}
