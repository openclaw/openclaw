import type { Db, Collection, Document } from "mongodb";
import type { MemoryMongoDBEmbeddingMode } from "../config/types.memory.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { DetectedCapabilities } from "./mongodb-schema.js";
import type { MemorySearchResult } from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { structuredMemCollection } from "./mongodb-schema.js";
import { buildVectorSearchStage, MONGODB_MAX_NUM_CANDIDATES } from "./mongodb-search.js";

const log = createSubsystemLogger("memory:mongodb:structured");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StructuredMemoryType =
  | "decision"
  | "preference"
  | "person"
  | "todo"
  | "fact"
  | "project"
  | "architecture"
  | "custom";

export type StructuredMemoryEntry = {
  type: StructuredMemoryType;
  key: string;
  value: string;
  context?: string;
  confidence?: number;
  source?: "agent" | "user" | "session" | "ingestion";
  sessionId?: string;
  agentId: string;
  tags?: string[];
};

// ---------------------------------------------------------------------------
// Write (upsert)
// ---------------------------------------------------------------------------

export async function writeStructuredMemory(params: {
  db: Db;
  prefix: string;
  entry: StructuredMemoryEntry;
  embeddingMode: MemoryMongoDBEmbeddingMode;
  embeddingProvider?: EmbeddingProvider;
}): Promise<{ upserted: boolean; id: string }> {
  const { db, prefix, entry, embeddingMode } = params;
  const collection = structuredMemCollection(db, prefix);

  // F13: Generate embedding for value + context combined text in managed mode
  let embedding: number[] | undefined;
  if (embeddingMode === "managed" && params.embeddingProvider) {
    try {
      const textToEmbed = entry.context ? `${entry.value} ${entry.context}` : entry.value;
      const [vec] = await params.embeddingProvider.embedBatch([textToEmbed]);
      embedding = vec;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`structured memory embedding failed: ${msg}`);
    }
  }

  const now = new Date();
  const setDoc: Document = {
    type: entry.type,
    key: entry.key,
    value: entry.value,
    agentId: entry.agentId,
    updatedAt: now,
  };
  if (entry.context !== undefined) {
    setDoc.context = entry.context;
  }
  if (entry.confidence !== undefined) {
    setDoc.confidence = entry.confidence;
  }
  if (entry.source !== undefined) {
    setDoc.source = entry.source;
  }
  if (entry.sessionId !== undefined) {
    setDoc.sessionId = entry.sessionId;
  }
  if (entry.tags !== undefined) {
    setDoc.tags = entry.tags;
  }
  if (embedding) {
    setDoc.embedding = embedding;
  }

  const setOnInsert: Document = {
    createdAt: now,
  };

  // Upsert by type + key (composite unique key)
  const result = await collection.updateOne(
    { type: entry.type, key: entry.key },
    { $set: setDoc, $setOnInsert: setOnInsert },
    { upsert: true },
  );

  const upserted = result.upsertedCount > 0;
  const id = result.upsertedId ? String(result.upsertedId) : entry.key;

  log.info(
    `structured memory ${upserted ? "created" : "updated"}: type=${entry.type} key=${entry.key}`,
  );
  return { upserted, id };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function toStructuredResult(doc: Document): MemorySearchResult {
  return {
    path: `structured:${doc.type ?? "unknown"}:${doc.key ?? ""}`,
    startLine: 0,
    endLine: 0,
    score: typeof doc.score === "number" ? Number(doc.score.toFixed(6)) : 0,
    snippet: typeof doc.value === "string" ? doc.value.slice(0, 700) : "",
    source: "structured",
  };
}

export async function searchStructuredMemory(
  collection: Collection,
  query: string,
  queryVector: number[] | null,
  opts: {
    maxResults: number;
    minScore?: number;
    filter?: { type?: string; tags?: string[] };
    capabilities: DetectedCapabilities;
    vectorIndexName: string;
    embeddingMode: MemoryMongoDBEmbeddingMode;
    numCandidates?: number;
  },
): Promise<MemorySearchResult[]> {
  const minScore = opts.minScore ?? 0.1;
  const canVector =
    opts.embeddingMode === "automated"
      ? opts.capabilities.vectorSearch
      : queryVector != null && opts.capabilities.vectorSearch;

  const numCandidates = Math.min(
    opts.numCandidates ?? Math.max(opts.maxResults * 20, 100),
    MONGODB_MAX_NUM_CANDIDATES,
  );

  // Try vector search (F5: uses shared buildVectorSearchStage)
  if (canVector) {
    try {
      const filter: Document = {};
      if (opts.filter?.type) {
        filter.type = opts.filter.type;
      }
      if (opts.filter?.tags?.length) {
        filter.tags = { $in: opts.filter.tags };
      }

      const vsStage = buildVectorSearchStage({
        queryVector,
        queryText: query,
        embeddingMode: opts.embeddingMode,
        indexName: opts.vectorIndexName,
        numCandidates,
        limit: opts.maxResults,
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        textFieldPath: "value", // structured memory stores text in "value" field
      });

      if (vsStage) {
        const pipeline: Document[] = [
          { $vectorSearch: vsStage },
          { $limit: opts.maxResults },
          {
            $project: {
              _id: 0,
              type: 1,
              key: 1,
              value: 1,
              context: 1,
              confidence: 1,
              tags: 1,
              score: { $meta: "vectorSearchScore" },
            },
          },
        ];

        const docs = await collection.aggregate(pipeline).toArray();
        const results = docs.map(toStructuredResult).filter((r) => r.score >= minScore);
        if (results.length > 0) {
          return results;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`structured memory vector search failed: ${msg}`);
    }
  }

  // $text fallback
  try {
    const matchFilter: Document = { $text: { $search: query } };
    if (opts.filter?.type) {
      matchFilter.type = opts.filter.type;
    }
    if (opts.filter?.tags?.length) {
      matchFilter.tags = { $in: opts.filter.tags };
    }

    const docs = await collection
      .aggregate([
        { $match: matchFilter },
        {
          $project: {
            _id: 0,
            type: 1,
            key: 1,
            value: 1,
            context: 1,
            confidence: 1,
            tags: 1,
            score: { $meta: "textScore" },
          },
        },
        { $sort: { score: { $meta: "textScore" } } },
        { $limit: opts.maxResults },
      ])
      .toArray();
    return docs.map(toStructuredResult).filter((r) => r.score >= minScore);
  } catch {
    log.warn("structured memory $text search fallback failed; returning empty results");
    return [];
  }
}

// ---------------------------------------------------------------------------
// Query by type
// ---------------------------------------------------------------------------

export async function getStructuredMemoryByType(
  db: Db,
  prefix: string,
  type: string,
  limit?: number,
): Promise<
  Array<{
    type: string;
    key: string;
    value: string;
    confidence: number;
    updatedAt: Date;
  }>
> {
  const collection = structuredMemCollection(db, prefix);
  const docs = await collection
    .find({ type }, { sort: { updatedAt: -1 }, limit: limit ?? 50 })
    .toArray();

  return docs.map((doc: Record<string, unknown>) => ({
    type: doc.type as string,
    key: doc.key as string,
    value: doc.value as string,
    confidence: (doc.confidence as number) ?? 0.8,
    updatedAt: doc.updatedAt as Date,
  }));
}
