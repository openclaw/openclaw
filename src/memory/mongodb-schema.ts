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

export function kbCollection(db: Db, prefix: string): Collection {
  return col(db, prefix, "knowledge_base");
}

export function kbChunksCollection(db: Db, prefix: string): Collection {
  return col(db, prefix, "kb_chunks");
}

export function structuredMemCollection(db: Db, prefix: string): Collection {
  return col(db, prefix, "structured_mem");
}

// ---------------------------------------------------------------------------
// Ensure collections exist (idempotent)
// ---------------------------------------------------------------------------

// JSON Schema validators for MongoDB-native collections.
// Uses $jsonSchema with validationAction: "warn" so invalid docs are still
// inserted but produce a warning in the server logs, avoiding hard failures
// for evolving schemas.

const KB_SCHEMA: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: ["hash", "title", "source", "updatedAt"],
    properties: {
      hash: { bsonType: "string", description: "Content hash for dedup" },
      title: { bsonType: "string", description: "Document title" },
      source: {
        bsonType: "object",
        required: ["type"],
        properties: {
          type: {
            enum: ["file", "url", "manual", "api"],
            description: "Source type",
          },
          path: { bsonType: "string" },
        },
      },
      category: { bsonType: "string" },
      tags: { bsonType: "array", items: { bsonType: "string" } },
      chunkCount: { bsonType: "number" },
      importedBy: { bsonType: "string" },
      updatedAt: { bsonType: "date" },
    },
  },
};

const KB_CHUNKS_SCHEMA: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: ["docId", "path", "text", "startLine", "endLine", "updatedAt"],
    properties: {
      docId: { bsonType: "string", description: "Reference to knowledge_base _id" },
      path: { bsonType: "string" },
      text: { bsonType: "string", description: "Chunk text content" },
      startLine: { bsonType: "number" },
      endLine: { bsonType: "number" },
      source: { bsonType: "string", description: "Source identifier (e.g., 'kb')" },
      embedding: { bsonType: "array", description: "Vector embedding (managed mode)" },
      updatedAt: { bsonType: "date" },
    },
  },
};

const STRUCTURED_MEM_SCHEMA: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: ["type", "key", "value", "updatedAt"],
    properties: {
      type: {
        bsonType: "string",
        description:
          "Memory type (decision, preference, fact, person, todo, project, architecture, custom)",
      },
      key: { bsonType: "string", description: "Unique key within type" },
      value: { bsonType: "string", description: "The observation/fact text" },
      context: { bsonType: "string" },
      confidence: { bsonType: "double", minimum: 0, maximum: 1 },
      tags: { bsonType: "array", items: { bsonType: "string" } },
      agentId: { bsonType: "string" },
      embedding: { bsonType: "array", description: "Vector embedding (managed mode)" },
      updatedAt: { bsonType: "date" },
    },
  },
};

const CHUNKS_SCHEMA: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: ["path", "text", "hash", "updatedAt"],
    properties: {
      path: { bsonType: "string" },
      text: { bsonType: "string" },
      hash: { bsonType: "string" },
      source: { bsonType: "string" },
      startLine: { bsonType: "number" },
      endLine: { bsonType: "number" },
      embedding: { bsonType: "array" },
      model: { bsonType: "string" },
      updatedAt: { bsonType: "date" },
    },
  },
};

const VALIDATED_COLLECTIONS: Record<string, Document> = {
  chunks: CHUNKS_SCHEMA,
  knowledge_base: KB_SCHEMA,
  kb_chunks: KB_CHUNKS_SCHEMA,
  structured_mem: STRUCTURED_MEM_SCHEMA,
};

export async function ensureCollections(db: Db, prefix: string): Promise<void> {
  const existing = new Set(
    await db
      .listCollections()
      .map((c) => c.name)
      .toArray(),
  );
  const needed = [
    "chunks",
    "files",
    "embedding_cache",
    "meta",
    "knowledge_base",
    "kb_chunks",
    "structured_mem",
  ].map((n) => `${prefix}${n}`);
  for (const name of needed) {
    if (!existing.has(name)) {
      // Strip prefix to look up validator
      const baseName = name.slice(prefix.length);
      const validator = VALIDATED_COLLECTIONS[baseName];
      if (validator) {
        await db.createCollection(name, {
          validator,
          validationLevel: "moderate",
          validationAction: "warn",
        });
      } else {
        await db.createCollection(name);
      }
      log.info(`created collection ${name}`);
    }
  }
}

/**
 * Apply JSON Schema validation to existing collections that were created
 * before validation was added. Idempotent — safe to call on every startup.
 * Uses validationAction: "warn" to avoid breaking existing data.
 */
export async function ensureSchemaValidation(db: Db, prefix: string): Promise<void> {
  for (const [baseName, validator] of Object.entries(VALIDATED_COLLECTIONS)) {
    const collName = `${prefix}${baseName}`;
    try {
      await db.command({
        collMod: collName,
        validator,
        validationLevel: "moderate",
        validationAction: "warn",
      });
      log.info(`applied schema validation to ${collName}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Collection might not exist yet — skip silently
      if (msg.includes("ns not found") || msg.includes("doesn't exist")) {
        continue;
      }
      log.warn(`schema validation for ${collName} failed: ${msg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Standard indexes (work on all MongoDB editions)
// ---------------------------------------------------------------------------

export async function ensureStandardIndexes(
  db: Db,
  prefix: string,
  ttlOpts?: { embeddingCacheTtlDays?: number; memoryTtlDays?: number },
): Promise<number> {
  let applied = 0;

  const chunks = chunksCollection(db, prefix);
  await chunks.createIndex({ path: 1 }, { name: "idx_chunks_path" });
  applied++;
  // F17: Removed idx_chunks_source — low-cardinality index (only "memory"/"sessions" values)
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

  // TTL index on embedding_cache for auto-expiry (per `index-ttl` rule).
  // When TTL is enabled, use TTL index instead of regular idx_cache_updated
  // because MongoDB cannot have two indexes on the same field with different options.
  // F18: Drop opposite-named index before creating to avoid IndexOptionsConflict.
  if (ttlOpts?.embeddingCacheTtlDays && ttlOpts.embeddingCacheTtlDays > 0) {
    try {
      await cache.dropIndex("idx_cache_updated");
    } catch {
      // Index may not exist — safe to ignore
    }
    const seconds = ttlOpts.embeddingCacheTtlDays * 24 * 60 * 60;
    await cache.createIndex(
      { updatedAt: 1 },
      { name: "idx_cache_ttl", expireAfterSeconds: seconds },
    );
    applied++;
    log.info(`created TTL index on embedding_cache: ${ttlOpts.embeddingCacheTtlDays} days`);
  } else {
    try {
      await cache.dropIndex("idx_cache_ttl");
    } catch {
      // Index may not exist — safe to ignore
    }
    await cache.createIndex({ updatedAt: 1 }, { name: "idx_cache_updated" });
    applied++;
  }

  // Optional TTL on files for memory auto-expiry
  // WARNING: This deletes memory files from MongoDB after ttlDays
  // F18: Drop opposite-named index before creating to avoid IndexOptionsConflict.
  if (ttlOpts?.memoryTtlDays && ttlOpts.memoryTtlDays > 0) {
    const files = filesCollection(db, prefix);
    try {
      await files.dropIndex("idx_files_updated");
    } catch {
      // Index may not exist — safe to ignore
    }
    const seconds = ttlOpts.memoryTtlDays * 24 * 60 * 60;
    await files.createIndex(
      { updatedAt: 1 },
      { name: "idx_files_ttl", expireAfterSeconds: seconds },
    );
    applied++;
    log.warn(
      `created TTL index on files: ${ttlOpts.memoryTtlDays} days — old memory files will be auto-deleted`,
    );
  } else {
    // Ensure no ghost TTL index from a previous config
    const files = filesCollection(db, prefix);
    try {
      await files.dropIndex("idx_files_ttl");
    } catch {
      // Index may not exist — safe to ignore
    }
  }

  // Knowledge Base indexes
  const kb = kbCollection(db, prefix);
  await kb.createIndex({ hash: 1 }, { name: "uq_kb_hash", unique: true });
  applied++;
  await kb.createIndex({ "source.type": 1, category: 1 }, { name: "idx_kb_source_category" });
  applied++;
  await kb.createIndex({ tags: 1 }, { name: "idx_kb_tags" });
  applied++;
  await kb.createIndex({ updatedAt: 1 }, { name: "idx_kb_updated" });
  applied++;
  // F10: Index for dedup-by-source-path queries during re-ingestion
  await kb.createIndex({ "source.path": 1 }, { name: "idx_kb_source_path", sparse: true });
  applied++;

  // KB Chunks indexes
  const kbChunks = kbChunksCollection(db, prefix);
  await kbChunks.createIndex({ docId: 1 }, { name: "idx_kbchunks_docid" });
  applied++;
  await kbChunks.createIndex(
    { path: 1, startLine: 1, endLine: 1 },
    { name: "uq_kbchunks_path_lines", unique: true },
  );
  applied++;
  // $text index on kb_chunks text field for text search fallback
  await kbChunks.createIndex({ text: "text" }, { name: "idx_kbchunks_text" });
  applied++;

  // Structured Memory indexes
  const structured = structuredMemCollection(db, prefix);
  await structured.createIndex(
    { type: 1, key: 1 },
    { name: "uq_structured_type_key", unique: true },
  );
  applied++;
  await structured.createIndex({ type: 1, updatedAt: -1 }, { name: "idx_structured_type_updated" });
  applied++;
  await structured.createIndex({ agentId: 1 }, { name: "idx_structured_agentid" });
  applied++;
  await structured.createIndex({ tags: 1 }, { name: "idx_structured_tags" });
  applied++;
  // $text index on structured_mem for text search fallback
  await structured.createIndex({ value: "text", context: "text" }, { name: "idx_structured_text" });
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
  numDimensions: number = 1024,
): Promise<{ text: boolean; vector: boolean }> {
  // 6 search indexes total: chunks (text + vector), kb_chunks (text + vector), structured_mem (text + vector).
  // For budget-constrained profiles (atlas-m0 has 3), create only the core chunks indexes.
  const budget = assertIndexBudget(profile, 6);
  const reducedBudget =
    !budget.withinBudget && typeof budget.budget === "number" && budget.budget >= 2;
  if (!budget.withinBudget && !reducedBudget) {
    log.warn(
      `search index budget exceeded: planned=${budget.plannedSearchIndexes} budget=${budget.budget} profile=${profile}`,
    );
    return { text: false, vector: false };
  }
  if (reducedBudget) {
    log.warn(
      `search index budget tight (${budget.budget}/${budget.plannedSearchIndexes}): creating core chunks indexes only, skipping KB and structured memory search indexes`,
    );
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
            numDimensions,
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

  // KB Chunks search indexes (skipped when budget is tight — core chunks indexes take priority)
  if (reducedBudget) {
    return { text: textCreated, vector: vectorCreated };
  }
  const kbChunks = kbChunksCollection(db, prefix);
  try {
    const kbTextDef: Document = {
      mappings: {
        dynamic: false,
        fields: {
          text: { type: "string", analyzer: "lucene.standard" },
          path: { type: "token" },
          docId: { type: "token" },
          updatedAt: { type: "date" },
        },
      },
    };
    await kbChunks.createSearchIndex({
      name: `${prefix}kb_chunks_text`,
      type: "search",
      definition: kbTextDef,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already exists") && !msg.includes("duplicate")) {
      log.warn(`kb_chunks text search index creation failed: ${msg}`);
    }
  }

  try {
    const kbFilterFields: Document[] = [
      { type: "filter", path: "docId" },
      { type: "filter", path: "path" },
    ];

    let kbVectorDef: Document;
    if (embeddingMode === "automated") {
      kbVectorDef = {
        fields: [
          { type: "autoEmbed", modality: "text", path: "text", model: "voyage-4-large" },
          ...kbFilterFields,
        ],
      };
    } else {
      kbVectorDef = {
        fields: [
          {
            type: "vector",
            path: "embedding",
            numDimensions,
            similarity: "cosine",
            ...(quantization !== "none" ? { quantization } : {}),
          },
          ...kbFilterFields,
        ],
      };
    }

    await kbChunks.createSearchIndex({
      name: `${prefix}kb_chunks_vector`,
      type: "vectorSearch",
      definition: kbVectorDef,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already exists") && !msg.includes("duplicate")) {
      log.warn(`kb_chunks vector search index creation failed: ${msg}`);
    }
  }

  // Structured Memory search indexes
  const structured = structuredMemCollection(db, prefix);
  try {
    const structTextDef: Document = {
      mappings: {
        dynamic: false,
        fields: {
          value: { type: "string", analyzer: "lucene.standard" },
          context: { type: "string", analyzer: "lucene.standard" },
          type: { type: "token" },
          key: { type: "token" },
          tags: { type: "token" },
          updatedAt: { type: "date" },
        },
      },
    };
    await structured.createSearchIndex({
      name: `${prefix}structured_mem_text`,
      type: "search",
      definition: structTextDef,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already exists") && !msg.includes("duplicate")) {
      log.warn(`structured_mem text search index creation failed: ${msg}`);
    }
  }

  try {
    const structFilterFields: Document[] = [
      { type: "filter", path: "type" },
      { type: "filter", path: "tags" },
      { type: "filter", path: "agentId" },
    ];

    let structVectorDef: Document;
    if (embeddingMode === "automated") {
      structVectorDef = {
        fields: [
          { type: "autoEmbed", modality: "text", path: "value", model: "voyage-4-large" },
          ...structFilterFields,
        ],
      };
    } else {
      structVectorDef = {
        fields: [
          {
            type: "vector",
            path: "embedding",
            numDimensions,
            similarity: "cosine",
            ...(quantization !== "none" ? { quantization } : {}),
          },
          ...structFilterFields,
        ],
      };
    }

    await structured.createSearchIndex({
      name: `${prefix}structured_mem_vector`,
      type: "vectorSearch",
      definition: structVectorDef,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already exists") && !msg.includes("duplicate")) {
      log.warn(`structured_mem vector search index creation failed: ${msg}`);
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

  log.info(`detected capabilities: ${JSON.stringify(result)}`);
  return result;
}
