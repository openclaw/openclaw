import type { Collection, Document } from "mongodb";
import type { MemoryMongoDBEmbeddingMode } from "../config/types.memory.js";
import type { DetectedCapabilities } from "./mongodb-schema.js";
import type { MemorySearchResult } from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildVectorSearchStage, MONGODB_MAX_NUM_CANDIDATES } from "./mongodb-search.js";

const log = createSubsystemLogger("memory:mongodb:kb-search");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toKBSearchResult(doc: Document): MemorySearchResult {
  return {
    path: typeof doc.path === "string" ? doc.path : "",
    startLine: typeof doc.startLine === "number" ? doc.startLine : 0,
    endLine: typeof doc.endLine === "number" ? doc.endLine : 0,
    score: typeof doc.score === "number" ? Number(doc.score.toFixed(6)) : 0,
    snippet: typeof doc.text === "string" ? doc.text.slice(0, 700) : "",
    source: "kb",
  };
}

// ---------------------------------------------------------------------------
// KB Search
// ---------------------------------------------------------------------------

export async function searchKB(
  kbChunks: Collection,
  query: string,
  queryVector: number[] | null,
  opts: {
    maxResults: number;
    minScore: number;
    filter?: { tags?: string[]; category?: string; source?: string };
    vectorIndexName: string;
    textIndexName: string;
    capabilities: DetectedCapabilities;
    embeddingMode: MemoryMongoDBEmbeddingMode;
    numCandidates?: number;
  },
): Promise<MemorySearchResult[]> {
  const canVector =
    opts.embeddingMode === "automated"
      ? opts.capabilities.vectorSearch
      : queryVector != null && opts.capabilities.vectorSearch;

  const canText = opts.capabilities.textSearch;
  const numCandidates = Math.min(
    opts.numCandidates ?? Math.max(opts.maxResults * 20, 100),
    MONGODB_MAX_NUM_CANDIDATES,
  );

  // F12: Try hybrid search (rankFusion) when both vector and text are available
  if (canVector && canText && opts.capabilities.rankFusion) {
    try {
      const vsStage = buildVectorSearchStage({
        queryVector,
        queryText: query,
        embeddingMode: opts.embeddingMode,
        indexName: opts.vectorIndexName,
        numCandidates,
        limit: opts.maxResults,
      });

      if (vsStage) {
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
                        },
                      },
                    },
                    { $limit: opts.maxResults * 4 },
                  ],
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
              docId: 1,
              score: { $meta: "searchScore" },
            },
          },
        ];

        const docs = await kbChunks.aggregate(pipeline).toArray();
        const results = docs.map(toKBSearchResult).filter((r) => r.score >= opts.minScore);
        if (results.length > 0) {
          return results;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`KB hybrid search ($rankFusion) failed, falling back to vector-only: ${msg}`);
    }
  }

  // Try vector search (vector-only fallback)
  if (canVector) {
    try {
      const vsStage = buildVectorSearchStage({
        queryVector,
        queryText: query,
        embeddingMode: opts.embeddingMode,
        indexName: opts.vectorIndexName,
        numCandidates,
        limit: opts.maxResults,
      });

      if (vsStage) {
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
              docId: 1,
              score: { $meta: "vectorSearchScore" },
            },
          },
        ];

        const docs = await kbChunks.aggregate(pipeline).toArray();
        const results = docs.map(toKBSearchResult).filter((r) => r.score >= opts.minScore);
        if (results.length > 0) {
          return results;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`KB vector search failed: ${msg}`);
    }
  }

  // Keyword search fallback using $search
  if (canText) {
    try {
      const pipeline: Document[] = [
        {
          $search: {
            index: opts.textIndexName,
            compound: {
              must: [{ text: { query, path: "text" } }],
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
            docId: 1,
            score: { $meta: "searchScore" },
          },
        },
      ];

      const docs = await kbChunks.aggregate(pipeline).toArray();
      return docs
        .map(toKBSearchResult)
        .filter((r) => r.score >= opts.minScore)
        .slice(0, opts.maxResults);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`KB keyword search failed: ${msg}`);
    }
  }

  // Last resort: basic $text index search
  try {
    const filter: Document = { $text: { $search: query } };
    const docs = await kbChunks
      .aggregate([
        { $match: filter },
        {
          $project: {
            _id: 0,
            path: 1,
            startLine: 1,
            endLine: 1,
            text: 1,
            docId: 1,
            score: { $meta: "textScore" },
          },
        },
        { $sort: { score: { $meta: "textScore" } } },
        { $limit: opts.maxResults },
      ])
      .toArray();
    return docs.map(toKBSearchResult).filter((r) => r.score >= opts.minScore);
  } catch {
    log.warn("KB $text search fallback also failed; returning empty results");
    return [];
  }
}
