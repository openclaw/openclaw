import type { Db, Collection, Document } from "mongodb";
import type {
  MemoryMongoDBDeploymentProfile,
  MemoryMongoDBEmbeddingMode,
} from "../config/types.memory.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory:mongodb:schema");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DetectedCapabilities = {
  vectorSearch: boolean;
  textSearch: boolean;
  scoreFusion: boolean;
  rankFusion: boolean;
  automatedEmbedding: boolean;
};

export type MongoIndexBudgetCheck = {
  profile: MemoryMongoDBDeploymentProfile;
  plannedSearchIndexes: number;
  budget: number | "managed" | "self-managed";
  withinBudget: boolean;
};

// ---------------------------------------------------------------------------
// Collection helpers
// ---------------------------------------------------------------------------

function col(db: Db, prefix: string, name: string): Collection {
  return db.collection(`${prefix}${name}`);
}

export function chunksCollection(db: Db, prefix: string): Collection {
  return col(db, prefix, "chunks");
}

export function filesCollection(db: Db, prefix: string): Collection {
  return col(db, prefix, "files");
}

export function embeddingCacheCollection(db: Db, prefix: string): Collection {
  return col(db, prefix, "embedding_cache");
}

export function metaCollection(db: Db, prefix: string): Collection {
  return col(db, prefix, "meta");
}

// ---------------------------------------------------------------------------
// Ensure collections exist (idempotent)
// ---------------------------------------------------------------------------

export async function ensureCollections(db: Db, prefix: string): Promise<void> {
  const existing = new Set(
    await db
      .listCollections()
      .map((c) => c.name)
      .toArray(),
  );
  const needed = ["chunks", "files", "embedding_cache", "meta"].map((n) => `${prefix}${n}`);
  for (const name of needed) {
    if (!existing.has(name)) {
      await db.createCollection(name);
      log.info(`created collection ${name}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Standard indexes (work on all MongoDB editions)
// ---------------------------------------------------------------------------

export async function ensureStandardIndexes(db: Db, prefix: string): Promise<number> {
  let applied = 0;

  const chunks = chunksCollection(db, prefix);
  await chunks.createIndex({ path: 1 }, { name: "idx_chunks_path" });
  applied++;
  await chunks.createIndex({ source: 1 }, { name: "idx_chunks_source" });
  applied++;
  await chunks.createIndex({ path: 1, hash: 1 }, { name: "idx_chunks_path_hash" });
  applied++;
  await chunks.createIndex({ updatedAt: -1 }, { name: "idx_chunks_updated" });
  applied++;
  // $text index on text field — required for community-bare $text search fallback
  // (last resort when mongot is not available). Only one $text index per collection.
  await chunks.createIndex({ text: "text" }, { name: "idx_chunks_text" });
  applied++;

  const cache = embeddingCacheCollection(db, prefix);
  await cache.createIndex(
    { provider: 1, model: 1, providerKey: 1, hash: 1 },
    { name: "uq_embedding_cache_composite", unique: true },
  );
  applied++;
  await cache.createIndex({ updatedAt: 1 }, { name: "idx_cache_updated" });
  applied++;

  log.info(`ensured ${applied} standard indexes`);
  return applied;
}

// ---------------------------------------------------------------------------
// Search / Vector Search index creation
// ---------------------------------------------------------------------------

export async function ensureSearchIndexes(
  db: Db,
  prefix: string,
  profile: MemoryMongoDBDeploymentProfile,
  embeddingMode: MemoryMongoDBEmbeddingMode,
  quantization: "none" | "scalar" | "binary" = "none",
): Promise<{ text: boolean; vector: boolean }> {
  const budget = assertIndexBudget(profile, 2);
  if (!budget.withinBudget) {
    log.warn(
      `search index budget exceeded: planned=${budget.plannedSearchIndexes} budget=${budget.budget} profile=${profile}`,
    );
    return { text: false, vector: false };
  }

  if (profile === "community-bare") {
    log.info("community-bare profile: skipping Atlas Search/Vector Search index creation");
    return { text: false, vector: false };
  }

  const chunks = chunksCollection(db, prefix);
  let textCreated = false;
  let vectorCreated = false;

  // Atlas Search (text) index
  try {
    const textDef: Document = {
      mappings: {
        dynamic: false,
        fields: {
          text: { type: "string", analyzer: "lucene.standard" },
          source: { type: "token" },
          path: { type: "token" },
          updatedAt: { type: "date" },
        },
      },
    };
    await chunks.createSearchIndex({
      name: `${prefix}chunks_text`,
      type: "search",
      definition: textDef,
    });
    textCreated = true;
    log.info("created text search index");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists") || msg.includes("duplicate")) {
      textCreated = true;
    } else {
      log.warn(`text search index creation failed: ${msg}`);
    }
  }

  // Vector Search index
  try {
    const filterFields: Document[] = [
      { type: "filter", path: "source" },
      { type: "filter", path: "path" },
    ];

    let vectorDef: Document;
    if (embeddingMode === "automated") {
      // autoEmbed is its own field type — MongoDB generates and manages
      // embeddings at index-time and query-time using Voyage AI.
      // path points to the TEXT field (not an embedding field).
      vectorDef = {
        fields: [
          {
            type: "autoEmbed",
            modality: "text",
            path: "text",
            model: "voyage-4-large",
          },
          ...filterFields,
        ],
      };
    } else {
      // Manual/managed mode: application stores pre-computed embeddings
      // in the "embedding" field. path points to the EMBEDDING field.
      vectorDef = {
        fields: [
          {
            type: "vector",
            path: "embedding",
            numDimensions: 1536,
            similarity: "cosine",
            ...(quantization !== "none" ? { quantization } : {}),
          },
          ...filterFields,
        ],
      };
    }

    await chunks.createSearchIndex({
      name: `${prefix}chunks_vector`,
      type: "vectorSearch",
      definition: vectorDef,
    });
    vectorCreated = true;
    log.info(`created vector search index (mode=${embeddingMode}, quantization=${quantization})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists") || msg.includes("duplicate")) {
      vectorCreated = true;
    } else {
      log.warn(`vector search index creation failed: ${msg}`);
    }
  }

  return { text: textCreated, vector: vectorCreated };
}

// ---------------------------------------------------------------------------
// Index budget
// ---------------------------------------------------------------------------

const PROFILE_BUDGETS: Record<MemoryMongoDBDeploymentProfile, number | "managed" | "self-managed"> =
  {
    "atlas-default": "managed",
    "atlas-m0": 3,
    "community-mongot": "self-managed",
    "community-bare": "self-managed",
  };

export function assertIndexBudget(
  profile: MemoryMongoDBDeploymentProfile,
  plannedCount: number,
): MongoIndexBudgetCheck {
  const budget = PROFILE_BUDGETS[profile];
  if (typeof budget === "number") {
    return {
      profile,
      plannedSearchIndexes: plannedCount,
      budget,
      withinBudget: plannedCount <= budget,
    };
  }
  return { profile, plannedSearchIndexes: plannedCount, budget, withinBudget: true };
}

// ---------------------------------------------------------------------------
// Capability detection (probe what the connected MongoDB supports)
// ---------------------------------------------------------------------------

function isStageUnsupported(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("unrecognized pipeline stage") ||
    lower.includes("unknown top level operator") ||
    lower.includes("requires additional configuration") ||
    lower.includes("not allowed") ||
    lower.includes("not supported")
  );
}

export async function detectCapabilities(db: Db): Promise<DetectedCapabilities> {
  const result: DetectedCapabilities = {
    vectorSearch: false,
    textSearch: false,
    scoreFusion: false,
    rankFusion: false,
    automatedEmbedding: false,
  };

  // Probe $rankFusion (implies 8.0+)
  try {
    await db
      .collection("__probe__")
      .aggregate([
        {
          $rankFusion: {
            input: {
              pipelines: { a: [{ $match: { _id: null } }], b: [{ $match: { _id: null } }] },
            },
          },
        },
        { $limit: 1 },
      ])
      .toArray();
    result.rankFusion = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!isStageUnsupported(msg)) {
      // Stage is recognized even if execution fails on empty collection
      result.rankFusion = true;
    }
  }

  // Probe $scoreFusion (implies 8.2+)
  try {
    await db
      .collection("__probe__")
      .aggregate([
        {
          $scoreFusion: {
            input: { pipelines: { a: [{ $match: { _id: null } }] }, normalization: "none" },
          },
        },
        { $limit: 1 },
      ])
      .toArray();
    result.scoreFusion = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!isStageUnsupported(msg)) {
      result.scoreFusion = true;
    }
  }

  // Check for search indexes on any collection (indicates mongot is running)
  try {
    const collections = await db.listCollections().toArray();
    for (const col of collections.slice(0, 5)) {
      try {
        const indexes = await db.collection(col.name).listSearchIndexes().toArray();
        if (indexes.length >= 0) {
          // listSearchIndexes succeeded → mongot is available
          result.textSearch = true;
          result.vectorSearch = true;
          break;
        }
      } catch {
        // This collection doesn't support search indexes
      }
    }
  } catch {
    // listSearchIndexes not available
  }

  // Automated embedding is detected via search index definitions (check during index creation)
  // For now mark as available if vectorSearch is available (it's a configuration, not a runtime probe)
  result.automatedEmbedding = result.vectorSearch;

  log.info(`detected capabilities: ${JSON.stringify(result)}`);
  return result;
}
