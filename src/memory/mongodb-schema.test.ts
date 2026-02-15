import type { Db, Collection, Document } from "mongodb";
import { describe, it, expect, vi } from "vitest";
import {
  assertIndexBudget,
  detectCapabilities,
  ensureCollections,
  ensureSearchIndexes,
  ensureStandardIndexes,
  chunksCollection,
  filesCollection,
  embeddingCacheCollection,
  metaCollection,
  kbCollection,
  kbChunksCollection,
  structuredMemCollection,
} from "./mongodb-schema.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockCollection(name: string): Collection {
  return {
    collectionName: name,
    createIndex: vi.fn(async () => name),
    createSearchIndex: vi.fn(async () => name),
    dropIndex: vi.fn(async () => ({ ok: 1 })),
    listSearchIndexes: vi.fn(() => ({ toArray: async () => [] })),
    aggregate: vi.fn(() => ({ toArray: async () => [] })),
  } as unknown as Collection;
}

function mockDb(existingCollections: string[] = []): Db {
  const collections = new Map<string, Collection>();

  const db = {
    collection: vi.fn((name: string) => {
      if (!collections.has(name)) {
        collections.set(name, mockCollection(name));
      }
      return collections.get(name)!;
    }),
    createCollection: vi.fn(async (name: string) => {
      collections.set(name, mockCollection(name));
      return collections.get(name)!;
    }),
    listCollections: vi.fn(() => ({
      map: vi.fn(() => ({
        toArray: async () => existingCollections,
      })),
    })),
  } as unknown as Db;

  return db;
}

// ---------------------------------------------------------------------------
// Collection helper tests
// ---------------------------------------------------------------------------

describe("collection helpers", () => {
  it("chunksCollection returns prefixed collection", () => {
    const db = mockDb();
    chunksCollection(db, "test_");
    expect(db.collection).toHaveBeenCalledWith("test_chunks");
  });

  it("filesCollection returns prefixed collection", () => {
    const db = mockDb();
    filesCollection(db, "oc_");
    expect(db.collection).toHaveBeenCalledWith("oc_files");
  });

  it("embeddingCacheCollection returns prefixed collection", () => {
    const db = mockDb();
    embeddingCacheCollection(db, "oc_");
    expect(db.collection).toHaveBeenCalledWith("oc_embedding_cache");
  });

  it("metaCollection returns prefixed collection", () => {
    const db = mockDb();
    metaCollection(db, "oc_");
    expect(db.collection).toHaveBeenCalledWith("oc_meta");
  });

  it("kbCollection returns prefixed collection", () => {
    const db = mockDb();
    kbCollection(db, "oc_");
    expect(db.collection).toHaveBeenCalledWith("oc_knowledge_base");
  });

  it("kbChunksCollection returns prefixed collection", () => {
    const db = mockDb();
    kbChunksCollection(db, "oc_");
    expect(db.collection).toHaveBeenCalledWith("oc_kb_chunks");
  });

  it("structuredMemCollection returns prefixed collection", () => {
    const db = mockDb();
    structuredMemCollection(db, "oc_");
    expect(db.collection).toHaveBeenCalledWith("oc_structured_mem");
  });
});

// ---------------------------------------------------------------------------
// Schema validation constants
// ---------------------------------------------------------------------------

describe("schema constants", () => {
  it("kb_chunks schema uses string docId, not objectId (F9)", async () => {
    // Verify by creating a collection with the schema and checking the validator
    const db = mockDb([]);
    await ensureCollections(db, "test_");
    const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock.calls;
    const kbChunksCall = createCalls.find((c: unknown[]) => c[0] === "test_kb_chunks");
    expect(kbChunksCall).toBeDefined();
    const validator = kbChunksCall![1]?.validator;
    expect(validator.$jsonSchema.properties.docId.bsonType).toBe("string");
  });

  it("kb_chunks schema includes source field (F14)", async () => {
    const db = mockDb([]);
    await ensureCollections(db, "test_");
    const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock.calls;
    const kbChunksCall = createCalls.find((c: unknown[]) => c[0] === "test_kb_chunks");
    expect(kbChunksCall).toBeDefined();
    const validator = kbChunksCall![1]?.validator;
    expect(validator.$jsonSchema.properties.source).toBeDefined();
    expect(validator.$jsonSchema.properties.source.bsonType).toBe("string");
  });

  it("KB source.type enum uses 'manual' not 'text' (F16)", async () => {
    const db = mockDb([]);
    await ensureCollections(db, "test_");
    const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock.calls;
    const kbCall = createCalls.find((c: unknown[]) => c[0] === "test_knowledge_base");
    expect(kbCall).toBeDefined();
    const validator = kbCall![1]?.validator;
    const sourceTypeEnum = validator.$jsonSchema.properties.source.properties.type.enum;
    expect(sourceTypeEnum).toContain("manual");
    expect(sourceTypeEnum).not.toContain("text");
  });

  it("chunks collection has schema validation (F15)", async () => {
    const db = mockDb([]);
    await ensureCollections(db, "test_");
    const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock.calls;
    const chunksCall = createCalls.find((c: unknown[]) => c[0] === "test_chunks");
    expect(chunksCall).toBeDefined();
    // F15: chunks should have schema validation
    expect(chunksCall![1]?.validator).toBeDefined();
    expect(chunksCall![1]?.validator.$jsonSchema.required).toContain("path");
    expect(chunksCall![1]?.validator.$jsonSchema.required).toContain("text");
  });
});

// ---------------------------------------------------------------------------
// ensureCollections
// ---------------------------------------------------------------------------

describe("ensureCollections", () => {
  it("creates all 7 collections when none exist", async () => {
    const db = mockDb([]);
    await ensureCollections(db, "test_");
    expect(db.createCollection).toHaveBeenCalledTimes(7);
    // Non-validated collections: called with name only
    expect(db.createCollection).toHaveBeenCalledWith("test_files");
    expect(db.createCollection).toHaveBeenCalledWith("test_embedding_cache");
    expect(db.createCollection).toHaveBeenCalledWith("test_meta");
    // Validated collections: called with name + validator options (F15: chunks now validated)
    expect(db.createCollection).toHaveBeenCalledWith(
      "test_chunks",
      expect.objectContaining({ validationAction: "warn" }),
    );
    expect(db.createCollection).toHaveBeenCalledWith(
      "test_knowledge_base",
      expect.objectContaining({ validationAction: "warn" }),
    );
    expect(db.createCollection).toHaveBeenCalledWith(
      "test_kb_chunks",
      expect.objectContaining({ validationAction: "warn" }),
    );
    expect(db.createCollection).toHaveBeenCalledWith(
      "test_structured_mem",
      expect.objectContaining({ validationAction: "warn" }),
    );
  });

  it("skips already-existing collections", async () => {
    const db = mockDb(["test_chunks", "test_files"]);
    await ensureCollections(db, "test_");
    expect(db.createCollection).toHaveBeenCalledTimes(5);
    expect(db.createCollection).toHaveBeenCalledWith("test_embedding_cache");
    expect(db.createCollection).toHaveBeenCalledWith("test_meta");
    expect(db.createCollection).toHaveBeenCalledWith(
      "test_knowledge_base",
      expect.objectContaining({ validationAction: "warn" }),
    );
    expect(db.createCollection).toHaveBeenCalledWith(
      "test_kb_chunks",
      expect.objectContaining({ validationAction: "warn" }),
    );
    // Note: test_chunks is already existing in this test case
  });

  it("does nothing when all collections exist", async () => {
    const db = mockDb([
      "oc_chunks",
      "oc_files",
      "oc_embedding_cache",
      "oc_meta",
      "oc_knowledge_base",
      "oc_kb_chunks",
      "oc_structured_mem",
    ]);
    await ensureCollections(db, "oc_");
    expect(db.createCollection).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ensureStandardIndexes
// ---------------------------------------------------------------------------

describe("ensureStandardIndexes", () => {
  it("creates all standard indexes on chunks, embedding_cache, KB, and structured_mem", async () => {
    const db = mockDb();
    const count = await ensureStandardIndexes(db, "test_");

    const chunks = db.collection("test_chunks") as unknown as {
      createIndex: ReturnType<typeof vi.fn>;
    };
    const cache = db.collection("test_embedding_cache") as unknown as {
      createIndex: ReturnType<typeof vi.fn>;
    };
    const kb = db.collection("test_knowledge_base") as unknown as {
      createIndex: ReturnType<typeof vi.fn>;
    };
    const kbChunks = db.collection("test_kb_chunks") as unknown as {
      createIndex: ReturnType<typeof vi.fn>;
    };
    const structured = db.collection("test_structured_mem") as unknown as {
      createIndex: ReturnType<typeof vi.fn>;
    };

    // 4 chunk (F17: removed idx_chunks_source) + 2 cache + 5 KB (F10: +source_path) + 3 KB chunks + 5 structured = 19
    expect(count).toBe(19);
    expect(chunks.createIndex).toHaveBeenCalledTimes(4);
    expect(cache.createIndex).toHaveBeenCalledTimes(2);
    expect(kb.createIndex).toHaveBeenCalledTimes(5);
    expect(kbChunks.createIndex).toHaveBeenCalledTimes(3);
    expect(structured.createIndex).toHaveBeenCalledTimes(5);
  });

  it("creates $text index on text field for community-bare fallback", async () => {
    const db = mockDb();
    await ensureStandardIndexes(db, "test_");

    const chunks = db.collection("test_chunks") as unknown as {
      createIndex: ReturnType<typeof vi.fn>;
    };
    const calls = chunks.createIndex.mock.calls;
    const textIndexCall = calls.find(
      (c: unknown[]) =>
        c[0] &&
        typeof c[0] === "object" &&
        "text" in (c[0] as Record<string, unknown>) &&
        (c[0] as Record<string, unknown>).text === "text",
    );
    expect(textIndexCall).toBeDefined();
    expect(textIndexCall![1]).toEqual({ name: "idx_chunks_text" });
  });

  it("creates TTL index on embedding_cache when ttlDays is set", async () => {
    const db = mockDb();
    await ensureStandardIndexes(db, "test_", { embeddingCacheTtlDays: 30 });

    const cache = db.collection("test_embedding_cache") as unknown as {
      createIndex: ReturnType<typeof vi.fn>;
    };
    const calls = cache.createIndex.mock.calls;
    const ttlCall = calls.find(
      (c: unknown[]) =>
        c[1] &&
        typeof c[1] === "object" &&
        (c[1] as Record<string, unknown>).expireAfterSeconds !== undefined,
    );
    expect(ttlCall).toBeDefined();
    expect(ttlCall![1]).toMatchObject({
      expireAfterSeconds: 30 * 24 * 60 * 60,
      name: "idx_cache_ttl",
    });
  });

  it("skips regular idx_cache_updated when TTL is enabled (TTL index serves same purpose)", async () => {
    const db = mockDb();
    await ensureStandardIndexes(db, "test_", { embeddingCacheTtlDays: 7 });

    const cache = db.collection("test_embedding_cache") as unknown as {
      createIndex: ReturnType<typeof vi.fn>;
    };
    const calls = cache.createIndex.mock.calls;
    const regularUpdatedCall = calls.find(
      (c: unknown[]) =>
        c[1] &&
        typeof c[1] === "object" &&
        (c[1] as Record<string, unknown>).name === "idx_cache_updated",
    );
    // Regular idx_cache_updated should NOT be created when TTL is active
    expect(regularUpdatedCall).toBeUndefined();
  });

  it("creates regular idx_cache_updated when no TTL is configured", async () => {
    const db = mockDb();
    await ensureStandardIndexes(db, "test_");

    const cache = db.collection("test_embedding_cache") as unknown as {
      createIndex: ReturnType<typeof vi.fn>;
    };
    const calls = cache.createIndex.mock.calls;
    const regularCall = calls.find(
      (c: unknown[]) =>
        c[1] &&
        typeof c[1] === "object" &&
        (c[1] as Record<string, unknown>).name === "idx_cache_updated",
    );
    expect(regularCall).toBeDefined();
  });

  it("creates TTL index on files collection when memoryTtlDays is set", async () => {
    const db = mockDb();
    await ensureStandardIndexes(db, "test_", { memoryTtlDays: 90 });

    const files = db.collection("test_files") as unknown as {
      createIndex: ReturnType<typeof vi.fn>;
    };
    const calls = files.createIndex.mock.calls;
    const ttlCall = calls.find(
      (c: unknown[]) =>
        c[1] &&
        typeof c[1] === "object" &&
        (c[1] as Record<string, unknown>).name === "idx_files_ttl",
    );
    expect(ttlCall).toBeDefined();
    expect(ttlCall![1]).toMatchObject({
      expireAfterSeconds: 90 * 24 * 60 * 60,
      name: "idx_files_ttl",
    });
  });

  it("skips files TTL index when memoryTtlDays is 0", async () => {
    const db = mockDb();
    await ensureStandardIndexes(db, "test_", { memoryTtlDays: 0 });

    const files = db.collection("test_files") as unknown as {
      createIndex: ReturnType<typeof vi.fn>;
    };
    const calls = files.createIndex.mock.calls;
    const ttlCall = calls.find(
      (c: unknown[]) =>
        c[1] &&
        typeof c[1] === "object" &&
        (c[1] as Record<string, unknown>).name === "idx_files_ttl",
    );
    expect(ttlCall).toBeUndefined();
  });

  it("drops idx_cache_updated before creating idx_cache_ttl (F18)", async () => {
    const db = mockDb();
    await ensureStandardIndexes(db, "test_", { embeddingCacheTtlDays: 30 });

    const cache = db.collection("test_embedding_cache") as unknown as {
      dropIndex: ReturnType<typeof vi.fn>;
    };
    expect(cache.dropIndex).toHaveBeenCalledWith("idx_cache_updated");
  });

  it("drops idx_cache_ttl before creating idx_cache_updated when no TTL (F18)", async () => {
    const db = mockDb();
    await ensureStandardIndexes(db, "test_");

    const cache = db.collection("test_embedding_cache") as unknown as {
      dropIndex: ReturnType<typeof vi.fn>;
    };
    expect(cache.dropIndex).toHaveBeenCalledWith("idx_cache_ttl");
  });

  it("index count reduced by 1 after F17 idx_chunks_source removal, +1 for F10 source_path", async () => {
    const db = mockDb();
    const count = await ensureStandardIndexes(db, "test_");
    // F17: removed idx_chunks_source (-1), F10: added idx_kb_source_path (+1) = net 0 from 19
    expect(count).toBe(19);
  });

  it("creates unique composite index on embedding_cache", async () => {
    const db = mockDb();
    await ensureStandardIndexes(db, "test_");

    const cache = db.collection("test_embedding_cache") as unknown as {
      createIndex: ReturnType<typeof vi.fn>;
    };
    const calls = cache.createIndex.mock.calls;
    const uniqueCall = calls.find(
      (c: unknown[]) =>
        c[1] && typeof c[1] === "object" && (c[1] as Record<string, unknown>).unique === true,
    );
    expect(uniqueCall).toBeDefined();
    expect(uniqueCall![0]).toEqual({ provider: 1, model: 1, providerKey: 1, hash: 1 });
  });
});

// ---------------------------------------------------------------------------
// ensureSearchIndexes
// ---------------------------------------------------------------------------

describe("ensureSearchIndexes", () => {
  it("skips search index creation for community-bare profile", async () => {
    const db = mockDb();
    const result = await ensureSearchIndexes(db, "test_", "community-bare", "managed");
    expect(result).toEqual({ text: false, vector: false });

    const chunks = db.collection("test_chunks") as unknown as {
      createSearchIndex: ReturnType<typeof vi.fn>;
    };
    expect(chunks.createSearchIndex).not.toHaveBeenCalled();
  });

  it("creates text + vector search indexes for atlas-default in managed mode", async () => {
    const db = mockDb();
    const result = await ensureSearchIndexes(db, "test_", "atlas-default", "managed");
    expect(result).toEqual({ text: true, vector: true });

    const chunks = db.collection("test_chunks") as unknown as {
      createSearchIndex: ReturnType<typeof vi.fn>;
    };
    // 2 search indexes on chunks collection (text + vector)
    expect(chunks.createSearchIndex).toHaveBeenCalledTimes(2);

    // Check text index
    const textCall = chunks.createSearchIndex.mock.calls.find(
      (c: unknown[]) => (c[0] as Document).type === "search",
    );
    expect(textCall).toBeDefined();
    expect((textCall![0] as Document).name).toBe("test_chunks_text");

    // Check vector index (managed mode: type=vector, path=embedding)
    const vectorCall = chunks.createSearchIndex.mock.calls.find(
      (c: unknown[]) => (c[0] as Document).type === "vectorSearch",
    );
    expect(vectorCall).toBeDefined();
    expect((vectorCall![0] as Document).name).toBe("test_chunks_vector");
    const vectorFields = (vectorCall![0] as Document).definition.fields;
    const vectorField = vectorFields.find((f: Document) => f.type === "vector");
    expect(vectorField).toBeDefined();
    expect(vectorField.path).toBe("embedding");
    expect(vectorField.numDimensions).toBe(1024);
    expect(vectorField.similarity).toBe("cosine");

    // Also verify KB chunks and structured mem search indexes
    const kbChunksCol = db.collection("test_kb_chunks") as unknown as {
      createSearchIndex: ReturnType<typeof vi.fn>;
    };
    expect(kbChunksCol.createSearchIndex).toHaveBeenCalledTimes(2);

    const structuredCol = db.collection("test_structured_mem") as unknown as {
      createSearchIndex: ReturnType<typeof vi.fn>;
    };
    expect(structuredCol.createSearchIndex).toHaveBeenCalledTimes(2);
  });

  it("creates autoEmbed vector index for automated mode", async () => {
    const db = mockDb();
    const result = await ensureSearchIndexes(db, "test_", "atlas-default", "automated");
    expect(result).toEqual({ text: true, vector: true });

    const chunks = db.collection("test_chunks") as unknown as {
      createSearchIndex: ReturnType<typeof vi.fn>;
    };
    const vectorCall = chunks.createSearchIndex.mock.calls.find(
      (c: unknown[]) => (c[0] as Document).type === "vectorSearch",
    );
    expect(vectorCall).toBeDefined();

    const vectorFields = (vectorCall![0] as Document).definition.fields;
    const autoEmbedField = vectorFields.find((f: Document) => f.type === "autoEmbed");
    expect(autoEmbedField).toBeDefined();
    expect(autoEmbedField.modality).toBe("text");
    expect(autoEmbedField.path).toBe("text");
    expect(autoEmbedField.model).toBe("voyage-4-large");
  });

  it("includes quantization in managed mode when not none", async () => {
    const db = mockDb();
    await ensureSearchIndexes(db, "test_", "atlas-default", "managed", "scalar");

    const chunks = db.collection("test_chunks") as unknown as {
      createSearchIndex: ReturnType<typeof vi.fn>;
    };
    const vectorCall = chunks.createSearchIndex.mock.calls.find(
      (c: unknown[]) => (c[0] as Document).type === "vectorSearch",
    );
    const vectorFields = (vectorCall![0] as Document).definition.fields;
    const vectorField = vectorFields.find((f: Document) => f.type === "vector");
    expect(vectorField.quantization).toBe("scalar");
  });

  it("omits quantization when set to none", async () => {
    const db = mockDb();
    await ensureSearchIndexes(db, "test_", "atlas-default", "managed", "none");

    const chunks = db.collection("test_chunks") as unknown as {
      createSearchIndex: ReturnType<typeof vi.fn>;
    };
    const vectorCall = chunks.createSearchIndex.mock.calls.find(
      (c: unknown[]) => (c[0] as Document).type === "vectorSearch",
    );
    const vectorFields = (vectorCall![0] as Document).definition.fields;
    const vectorField = vectorFields.find((f: Document) => f.type === "vector");
    expect(vectorField.quantization).toBeUndefined();
  });

  it("uses custom numDimensions in managed mode vector index", async () => {
    const db = mockDb();
    await ensureSearchIndexes(db, "test_", "atlas-default", "managed", "none", 1024);

    const chunks = db.collection("test_chunks") as unknown as {
      createSearchIndex: ReturnType<typeof vi.fn>;
    };
    const vectorCall = chunks.createSearchIndex.mock.calls.find(
      (c: unknown[]) => (c[0] as Document).type === "vectorSearch",
    );
    expect(vectorCall).toBeDefined();
    const vectorFields = (vectorCall![0] as Document).definition.fields;
    const vectorField = vectorFields.find((f: Document) => f.type === "vector");
    expect(vectorField.numDimensions).toBe(1024);
  });

  it("defaults numDimensions to 1024 when not specified", async () => {
    const db = mockDb();
    await ensureSearchIndexes(db, "test_", "atlas-default", "managed", "none");

    const chunks = db.collection("test_chunks") as unknown as {
      createSearchIndex: ReturnType<typeof vi.fn>;
    };
    const vectorCall = chunks.createSearchIndex.mock.calls.find(
      (c: unknown[]) => (c[0] as Document).type === "vectorSearch",
    );
    const vectorFields = (vectorCall![0] as Document).definition.fields;
    const vectorField = vectorFields.find((f: Document) => f.type === "vector");
    expect(vectorField.numDimensions).toBe(1024);
  });

  it("includes filter fields (source, path) in vector index", async () => {
    const db = mockDb();
    await ensureSearchIndexes(db, "test_", "community-mongot", "managed");

    const chunks = db.collection("test_chunks") as unknown as {
      createSearchIndex: ReturnType<typeof vi.fn>;
    };
    const vectorCall = chunks.createSearchIndex.mock.calls.find(
      (c: unknown[]) => (c[0] as Document).type === "vectorSearch",
    );
    const vectorFields = (vectorCall![0] as Document).definition.fields;
    const filterFields = vectorFields.filter((f: Document) => f.type === "filter");
    expect(filterFields).toHaveLength(2);
    expect(filterFields.map((f: Document) => f.path).toSorted()).toEqual(["path", "source"]);
  });

  it("handles 'already exists' errors gracefully", async () => {
    const db = mockDb();
    const chunks = db.collection("test_chunks") as unknown as {
      createSearchIndex: ReturnType<typeof vi.fn>;
    };
    chunks.createSearchIndex.mockRejectedValue(new Error("index already exists"));

    const result = await ensureSearchIndexes(db, "test_", "atlas-default", "managed");
    // Both should be true because "already exists" means the index is there
    expect(result).toEqual({ text: true, vector: true });
  });
});

// ---------------------------------------------------------------------------
// assertIndexBudget
// ---------------------------------------------------------------------------

describe("assertIndexBudget", () => {
  it("atlas-m0 has budget of 3", () => {
    const result = assertIndexBudget("atlas-m0", 2);
    expect(result.budget).toBe(3);
    expect(result.withinBudget).toBe(true);
  });

  it("atlas-m0 rejects when over budget", () => {
    const result = assertIndexBudget("atlas-m0", 4);
    expect(result.budget).toBe(3);
    expect(result.withinBudget).toBe(false);
  });

  it("atlas-default has managed budget (unlimited)", () => {
    const result = assertIndexBudget("atlas-default", 100);
    expect(result.budget).toBe("managed");
    expect(result.withinBudget).toBe(true);
  });

  it("community-mongot has self-managed budget (unlimited)", () => {
    const result = assertIndexBudget("community-mongot", 50);
    expect(result.budget).toBe("self-managed");
    expect(result.withinBudget).toBe(true);
  });

  it("community-bare has self-managed budget (unlimited)", () => {
    const result = assertIndexBudget("community-bare", 10);
    expect(result.budget).toBe("self-managed");
    expect(result.withinBudget).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectCapabilities
// ---------------------------------------------------------------------------

describe("detectCapabilities", () => {
  it("detects no capabilities when everything fails", async () => {
    const db = {
      collection: vi.fn(() => ({
        aggregate: vi.fn(() => ({
          toArray: vi.fn(async () => {
            throw new Error("unrecognized pipeline stage");
          }),
        })),
        listSearchIndexes: vi.fn(() => ({
          toArray: vi.fn(async () => {
            throw new Error("not supported");
          }),
        })),
      })),
      listCollections: vi.fn(() => ({
        toArray: async () => [],
      })),
    } as unknown as Db;

    const caps = await detectCapabilities(db);
    expect(caps.vectorSearch).toBe(false);
    expect(caps.textSearch).toBe(false);
    expect(caps.scoreFusion).toBe(false);
    expect(caps.rankFusion).toBe(false);
  });

  it("detects rankFusion when stage is recognized but fails on empty data", async () => {
    const db = {
      collection: vi.fn(() => ({
        aggregate: vi.fn(() => ({
          toArray: vi.fn(async () => {
            // Recognized but fails with a runtime error (not "unrecognized")
            throw new Error("Cannot run $rankFusion on empty pipelines");
          }),
        })),
        listSearchIndexes: vi.fn(() => ({
          toArray: vi.fn(async () => {
            throw new Error("not supported");
          }),
        })),
      })),
      listCollections: vi.fn(() => ({
        toArray: async () => [],
      })),
    } as unknown as Db;

    const caps = await detectCapabilities(db);
    // Stage recognized (error isn't "unrecognized") → capability = true
    expect(caps.rankFusion).toBe(true);
    expect(caps.scoreFusion).toBe(true);
  });

  it("detects vectorSearch and textSearch when listSearchIndexes succeeds", async () => {
    const db = {
      collection: vi.fn(() => ({
        aggregate: vi.fn(() => ({
          toArray: vi.fn(async () => {
            throw new Error("unrecognized pipeline stage");
          }),
        })),
        listSearchIndexes: vi.fn(() => ({
          toArray: vi.fn(async () => []),
        })),
      })),
      listCollections: vi.fn(() => ({
        toArray: async () => [{ name: "test_chunks" }],
      })),
    } as unknown as Db;

    const caps = await detectCapabilities(db);
    expect(caps.vectorSearch).toBe(true);
    expect(caps.textSearch).toBe(true);
    // automatedEmbedding removed (F2: dead code)
  });
});
