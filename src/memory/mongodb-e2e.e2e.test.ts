/**
 * MongoDB E2E tests — requires a running MongoDB 8.2+ instance.
 *
 * Run manually:
 *   docker run -d --name clawmongo-test -p 27117:27017 mongo:8.2
 *   MONGODB_TEST_URI=mongodb://localhost:27117 npx vitest run src/memory/mongodb-e2e.e2e.test.ts
 *
 * These tests exercise the real MongoDB driver and server operations
 * against a Community Edition instance WITHOUT mongot (community-bare profile).
 */

import { MongoClient, type Db } from "mongodb";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  chunksCollection,
  filesCollection,
  embeddingCacheCollection,
  metaCollection,
  ensureCollections,
  ensureStandardIndexes,
  ensureSearchIndexes,
  detectCapabilities,
} from "./mongodb-schema.js";
import { syncToMongoDB } from "./mongodb-sync.js";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const TEST_URI = process.env.MONGODB_TEST_URI ?? "mongodb://localhost:27117";
const TEST_DB = "clawmongo_e2e_test";
const TEST_PREFIX = "e2e_";

let client: MongoClient;
let db: Db;
let tmpDir: string;

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  client = new MongoClient(TEST_URI, {
    serverSelectionTimeoutMS: 5_000,
    connectTimeoutMS: 5_000,
  });
  await client.connect();
  await client.db("admin").command({ ping: 1 });
  db = client.db(TEST_DB);
  // Clean slate
  await db.dropDatabase();
});

afterAll(async () => {
  if (db) {
    await db.dropDatabase();
  }
  if (client) {
    await client.close();
  }
});

beforeEach(async () => {
  // Drop and recreate for each test group that needs fresh state
});

// ---------------------------------------------------------------------------
// Helper: create workspace with memory files
// ---------------------------------------------------------------------------

async function setupWorkspace(files: Record<string, string>): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawmongo-e2e-"));
  const memDir = path.join(tmpDir, "memory");
  await fs.mkdir(memDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(memDir, name), content, "utf-8");
  }
  return tmpDir;
}

async function cleanupWorkspace(): Promise<void> {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ===========================================================================
// Collection and Index Tests
// ===========================================================================

describe("E2E: MongoDB Collections and Indexes", () => {
  it("creates all required collections", async () => {
    await ensureCollections(db, TEST_PREFIX);

    const collections = await db.listCollections().toArray();
    const names = collections.map((c) => c.name);

    expect(names).toContain(`${TEST_PREFIX}chunks`);
    expect(names).toContain(`${TEST_PREFIX}files`);
    expect(names).toContain(`${TEST_PREFIX}embedding_cache`);
    expect(names).toContain(`${TEST_PREFIX}meta`);
  });

  it("ensureCollections is idempotent", async () => {
    await ensureCollections(db, TEST_PREFIX);
    // Calling again should not throw
    await ensureCollections(db, TEST_PREFIX);

    const collections = await db.listCollections().toArray();
    const count = collections.filter((c) => c.name.startsWith(TEST_PREFIX)).length;
    expect(count).toBe(4);
  });

  it("creates standard indexes", async () => {
    await ensureCollections(db, TEST_PREFIX);
    const applied = await ensureStandardIndexes(db, TEST_PREFIX);
    expect(applied).toBe(7); // 5 chunks + 2 cache

    // Verify chunks indexes
    const chunksIndexes = await chunksCollection(db, TEST_PREFIX).indexes();
    const indexNames = chunksIndexes.map((i) => i.name);
    expect(indexNames).toContain("idx_chunks_path");
    expect(indexNames).toContain("idx_chunks_source");
    expect(indexNames).toContain("idx_chunks_path_hash");
    expect(indexNames).toContain("idx_chunks_updated");
    expect(indexNames).toContain("idx_chunks_text");

    // Verify $text index structure
    const textIdx = chunksIndexes.find((i) => i.name === "idx_chunks_text");
    expect(textIdx).toBeDefined();
    expect(textIdx!.key).toHaveProperty("_fts", "text");

    // Verify cache indexes
    const cacheIndexes = await embeddingCacheCollection(db, TEST_PREFIX).indexes();
    const cacheNames = cacheIndexes.map((i) => i.name);
    expect(cacheNames).toContain("uq_embedding_cache_composite");
    expect(cacheNames).toContain("idx_cache_updated");

    // Verify the unique index
    const uniqueIdx = cacheIndexes.find((i) => i.name === "uq_embedding_cache_composite");
    expect(uniqueIdx?.unique).toBe(true);
  });

  it("ensureStandardIndexes is idempotent", async () => {
    const applied1 = await ensureStandardIndexes(db, TEST_PREFIX);
    const applied2 = await ensureStandardIndexes(db, TEST_PREFIX);
    expect(applied1).toBe(applied2);
  });

  it("search index creation fails gracefully on community-bare", async () => {
    const result = await ensureSearchIndexes(db, TEST_PREFIX, "community-bare", "automated");
    expect(result.text).toBe(false);
    expect(result.vector).toBe(false);
  });
});

// ===========================================================================
// Capability Detection Tests
// ===========================================================================

describe("E2E: Capability Detection", () => {
  it("detects capabilities on MongoDB 8.2 community (no mongot)", async () => {
    const caps = await detectCapabilities(db);

    // MongoDB 8.2 recognizes $rankFusion and $scoreFusion as valid stages
    // even on Community without mongot
    expect(caps.rankFusion).toBe(true);
    expect(caps.scoreFusion).toBe(true);

    // Without mongot, vectorSearch and textSearch should be false
    // (listSearchIndexes requires mongot)
    expect(caps.vectorSearch).toBe(false);
    expect(caps.textSearch).toBe(false);
  });
});

// ===========================================================================
// Sync Workflow Tests
// ===========================================================================

describe("E2E: Sync Workflow", () => {
  let workspaceDir: string;

  beforeAll(async () => {
    // Clean collections once at start for fresh sync
    await chunksCollection(db, TEST_PREFIX).deleteMany({});
    await filesCollection(db, TEST_PREFIX).deleteMany({});
  });

  afterAll(async () => {
    await cleanupWorkspace();
  });

  // Tests in this block are SEQUENTIAL — each builds on the previous state
  it("syncs memory files to MongoDB", async () => {
    workspaceDir = await setupWorkspace({
      "project-notes.md": [
        "# Project Notes",
        "",
        "This is a project about building a MongoDB backend.",
        "It uses vector search and text search for hybrid retrieval.",
        "",
        "## Architecture",
        "",
        "The system has four main files:",
        "- mongodb-schema.ts for collection and index management",
        "- mongodb-search.ts for search operations",
        "- mongodb-sync.ts for file synchronization",
        "- mongodb-manager.ts for the manager class",
      ].join("\n"),
      "decisions.md": [
        "# Decisions",
        "",
        "## Embedding Mode",
        "We chose automated embedding mode with Voyage AI.",
        "This means MongoDB handles embedding generation.",
        "",
        "## Fusion Method",
        "Default to scoreFusion for best quality hybrid search.",
      ].join("\n"),
    });

    const result = await syncToMongoDB({
      db,
      prefix: TEST_PREFIX,
      workspaceDir,
      embeddingMode: "automated",
    });

    expect(result.filesProcessed).toBe(2);
    expect(result.chunksUpserted).toBeGreaterThanOrEqual(2);
    expect(result.staleDeleted).toBe(0);

    // Verify documents in MongoDB
    const chunkCount = await chunksCollection(db, TEST_PREFIX).countDocuments();
    const fileCount = await filesCollection(db, TEST_PREFIX).countDocuments();
    expect(chunkCount).toBeGreaterThanOrEqual(2);
    expect(fileCount).toBe(2);

    // Verify chunk document structure
    const sampleChunk = await chunksCollection(db, TEST_PREFIX).findOne({});
    expect(sampleChunk).toBeDefined();
    expect(sampleChunk!.path).toMatch(/^memory\//);
    expect(sampleChunk!.source).toBe("memory");
    expect(typeof sampleChunk!.startLine).toBe("number");
    expect(typeof sampleChunk!.endLine).toBe("number");
    expect(typeof sampleChunk!.text).toBe("string");
    expect(typeof sampleChunk!.hash).toBe("string");
    expect(typeof sampleChunk!.model).toBe("string");
    expect(sampleChunk!.updatedAt).toBeInstanceOf(Date);

    // Verify file metadata
    const sampleFile = await filesCollection(db, TEST_PREFIX).findOne({});
    expect(sampleFile).toBeDefined();
    expect(sampleFile!.source).toBe("memory");
    expect(typeof sampleFile!.hash).toBe("string");
    expect(typeof sampleFile!.mtime).toBe("number");
    expect(typeof sampleFile!.size).toBe("number");
  });

  it("skips unchanged files on re-sync", async () => {
    // First sync already done above, do another
    const result = await syncToMongoDB({
      db,
      prefix: TEST_PREFIX,
      workspaceDir,
      embeddingMode: "automated",
    });

    // Files already indexed with same hash — should skip
    expect(result.filesProcessed).toBe(0);
    expect(result.chunksUpserted).toBe(0);
  });

  it("re-indexes when file content changes", async () => {
    // Modify a file
    const filePath = path.join(workspaceDir, "memory", "decisions.md");
    const newContent = [
      "# Decisions",
      "",
      "## Embedding Mode",
      "We chose managed embedding mode with local provider.",
      "CHANGED: This line is new and different.",
      "",
      "## Search Strategy",
      "Use rankFusion for better results across heterogeneous sources.",
    ].join("\n");
    await fs.writeFile(filePath, newContent, "utf-8");

    const result = await syncToMongoDB({
      db,
      prefix: TEST_PREFIX,
      workspaceDir,
      embeddingMode: "automated",
    });

    // Only the changed file should be re-indexed
    expect(result.filesProcessed).toBe(1);
    expect(result.chunksUpserted).toBeGreaterThanOrEqual(1);
  });

  it("force re-indexes all files", async () => {
    const result = await syncToMongoDB({
      db,
      prefix: TEST_PREFIX,
      workspaceDir,
      embeddingMode: "automated",
      force: true,
    });

    expect(result.filesProcessed).toBe(2);
    expect(result.chunksUpserted).toBeGreaterThanOrEqual(2);
  });

  it("deletes stale chunks when files are removed", async () => {
    // Delete a file
    await fs.unlink(path.join(workspaceDir, "memory", "decisions.md"));

    const result = await syncToMongoDB({
      db,
      prefix: TEST_PREFIX,
      workspaceDir,
      embeddingMode: "automated",
    });

    expect(result.staleDeleted).toBeGreaterThan(0);

    // Verify only project-notes.md chunks remain
    const chunks = await chunksCollection(db, TEST_PREFIX).find({}).toArray();
    for (const chunk of chunks) {
      expect(chunk.path).toBe("memory/project-notes.md");
    }

    // Files collection should only have 1 entry now
    const fileCount = await filesCollection(db, TEST_PREFIX).countDocuments();
    expect(fileCount).toBe(1);
  });

  it("reports progress during sync", async () => {
    // Recreate files
    await cleanupWorkspace();
    workspaceDir = await setupWorkspace({
      "a.md": "# File A\n\nContent for file A testing progress",
      "b.md": "# File B\n\nContent for file B testing progress",
      "c.md": "# File C\n\nContent for file C testing progress",
    });

    // Clear existing data
    await chunksCollection(db, TEST_PREFIX).deleteMany({});
    await filesCollection(db, TEST_PREFIX).deleteMany({});

    const progressUpdates: Array<{ completed: number; total: number; label?: string }> = [];
    await syncToMongoDB({
      db,
      prefix: TEST_PREFIX,
      workspaceDir,
      embeddingMode: "automated",
      progress: (update) => progressUpdates.push(update),
    });

    expect(progressUpdates.length).toBeGreaterThanOrEqual(3);
    // First update should be initial (completed=0)
    expect(progressUpdates[0].completed).toBe(0);
    expect(progressUpdates[0].total).toBe(3);
    // Last update should show completion
    const last = progressUpdates[progressUpdates.length - 1];
    expect(last.completed).toBe(last.total);
  });
});

// ===========================================================================
// $text Search Fallback Tests (community-bare)
// ===========================================================================

describe("E2E: $text Search (community-bare fallback)", () => {
  let workspaceDir: string;

  beforeAll(async () => {
    // Clean and sync fresh data
    await chunksCollection(db, TEST_PREFIX).deleteMany({});
    await filesCollection(db, TEST_PREFIX).deleteMany({});

    workspaceDir = await setupWorkspace({
      "mongodb-guide.md": [
        "# MongoDB Guide",
        "",
        "MongoDB is a document database that provides high availability",
        "and automatic scaling. It stores data in flexible JSON-like documents.",
        "",
        "## Vector Search",
        "MongoDB Atlas Vector Search allows you to perform semantic search",
        "using embeddings generated by machine learning models.",
        "",
        "## Aggregation Pipeline",
        "The aggregation framework provides powerful data processing capabilities.",
      ].join("\n"),
      "typescript-tips.md": [
        "# TypeScript Tips",
        "",
        "TypeScript is a strongly typed programming language that builds on JavaScript.",
        "Use interfaces to define object shapes and type aliases for complex types.",
        "",
        "## Generics",
        "Generics provide a way to make components work with any data type.",
      ].join("\n"),
    });

    await syncToMongoDB({
      db,
      prefix: TEST_PREFIX,
      workspaceDir,
      embeddingMode: "automated",
      force: true,
    });
  });

  afterAll(async () => {
    await cleanupWorkspace();
  });

  it("$text search finds relevant documents", async () => {
    const col = chunksCollection(db, TEST_PREFIX);
    const docs = await col
      .find(
        { $text: { $search: "MongoDB vector search" } },
        {
          projection: {
            _id: 0,
            path: 1,
            text: 1,
            source: 1,
            score: { $meta: "textScore" },
          },
        },
      )
      .toSorted({ score: { $meta: "textScore" } })
      .limit(5)
      .toArray();

    expect(docs.length).toBeGreaterThan(0);
    // MongoDB-related content should score higher
    expect(docs[0].path).toContain("mongodb-guide.md");
    expect(docs[0].score).toBeGreaterThan(0);
    expect(docs[0].source).toBe("memory");
  });

  it("$text search returns empty for unrelated queries", async () => {
    const col = chunksCollection(db, TEST_PREFIX);
    const docs = await col
      .find(
        { $text: { $search: "quantum physics entanglement" } },
        {
          projection: {
            score: { $meta: "textScore" },
          },
        },
      )
      .toSorted({ score: { $meta: "textScore" } })
      .limit(5)
      .toArray();

    expect(docs.length).toBe(0);
  });

  it("$text search with source filter", async () => {
    const col = chunksCollection(db, TEST_PREFIX);
    const docs = await col
      .find(
        { $text: { $search: "TypeScript" }, source: "memory" },
        {
          projection: {
            path: 1,
            text: 1,
            source: 1,
            score: { $meta: "textScore" },
          },
        },
      )
      .toSorted({ score: { $meta: "textScore" } })
      .limit(5)
      .toArray();

    expect(docs.length).toBeGreaterThan(0);
    for (const doc of docs) {
      expect(doc.source).toBe("memory");
    }
  });
});

// ===========================================================================
// Full Search Dispatcher (community-bare path)
// ===========================================================================

describe("E2E: mongoSearch dispatcher (community-bare)", () => {
  // Import mongoSearch to test the full dispatcher cascade
  let mongoSearchFn: typeof import("./mongodb-search.js").mongoSearch;

  beforeAll(async () => {
    const mod = await import("./mongodb-search.js");
    mongoSearchFn = mod.mongoSearch;
  });

  it("falls through to $text search on community without mongot", async () => {
    const col = chunksCollection(db, TEST_PREFIX);
    const caps = await detectCapabilities(db);

    const results = await mongoSearchFn(col, "MongoDB document database", null, {
      maxResults: 5,
      minScore: 0,
      fusionMethod: "scoreFusion",
      capabilities: caps,
      vectorIndexName: `${TEST_PREFIX}chunks_vector`,
      textIndexName: `${TEST_PREFIX}chunks_text`,
      vectorWeight: 0.7,
      textWeight: 0.3,
      embeddingMode: "managed",
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toContain("mongodb-guide.md");
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].snippet.length).toBeGreaterThan(0);
    expect(results[0].source).toBe("memory");
  });

  it("returns empty for queries with no matches", async () => {
    const col = chunksCollection(db, TEST_PREFIX);
    const caps = await detectCapabilities(db);

    const results = await mongoSearchFn(col, "xyznonexistent12345", null, {
      maxResults: 5,
      minScore: 0,
      fusionMethod: "scoreFusion",
      capabilities: caps,
      vectorIndexName: `${TEST_PREFIX}chunks_vector`,
      textIndexName: `${TEST_PREFIX}chunks_text`,
      vectorWeight: 0.7,
      textWeight: 0.3,
      embeddingMode: "managed",
    });

    expect(results.length).toBe(0);
  });

  it("respects maxResults limit", async () => {
    const col = chunksCollection(db, TEST_PREFIX);
    const caps = await detectCapabilities(db);

    const results = await mongoSearchFn(col, "data", null, {
      maxResults: 1,
      minScore: 0,
      fusionMethod: "scoreFusion",
      capabilities: caps,
      vectorIndexName: `${TEST_PREFIX}chunks_vector`,
      textIndexName: `${TEST_PREFIX}chunks_text`,
      vectorWeight: 0.7,
      textWeight: 0.3,
      embeddingMode: "managed",
    });

    expect(results.length).toBeLessThanOrEqual(1);
  });
});

// ===========================================================================
// Chunk ID and Deduplication Tests
// ===========================================================================

describe("E2E: Chunk IDs and Deduplication", () => {
  let dedupWorkspace: string;

  beforeAll(async () => {
    // Set up fresh workspace and sync
    await chunksCollection(db, TEST_PREFIX).deleteMany({});
    await filesCollection(db, TEST_PREFIX).deleteMany({});

    dedupWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "clawmongo-dedup-"));
    const memDir = path.join(dedupWorkspace, "memory");
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(
      path.join(memDir, "dedup-test.md"),
      "# Dedup Test\n\nContent for deduplication testing across syncs",
      "utf-8",
    );

    await syncToMongoDB({
      db,
      prefix: TEST_PREFIX,
      workspaceDir: dedupWorkspace,
      embeddingMode: "automated",
      force: true,
    });
  });

  afterAll(async () => {
    await fs.rm(dedupWorkspace, { recursive: true, force: true }).catch(() => {});
  });

  it("chunks have deterministic _id based on path:startLine:endLine", async () => {
    const col = chunksCollection(db, TEST_PREFIX);
    const chunks = await col.find({}).toArray();

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      const expectedId = `${chunk.path}:${chunk.startLine}:${chunk.endLine}`;
      expect(String(chunk._id)).toBe(expectedId);
    }
  });

  it("re-sync upserts (not duplicates) existing chunks", async () => {
    const col = chunksCollection(db, TEST_PREFIX);
    const countBefore = await col.countDocuments();
    expect(countBefore).toBeGreaterThan(0);

    // Force re-sync should upsert, not create duplicates
    await syncToMongoDB({
      db,
      prefix: TEST_PREFIX,
      workspaceDir: dedupWorkspace,
      embeddingMode: "automated",
      force: true,
    });

    const countAfter = await col.countDocuments();
    expect(countAfter).toBe(countBefore);
  });
});

// ===========================================================================
// Collection Helper Tests
// ===========================================================================

describe("E2E: Collection Helpers", () => {
  it("collection helpers return correct collection names", () => {
    const chunks = chunksCollection(db, TEST_PREFIX);
    const files = filesCollection(db, TEST_PREFIX);
    const cache = embeddingCacheCollection(db, TEST_PREFIX);
    const meta = metaCollection(db, TEST_PREFIX);

    expect(chunks.collectionName).toBe(`${TEST_PREFIX}chunks`);
    expect(files.collectionName).toBe(`${TEST_PREFIX}files`);
    expect(cache.collectionName).toBe(`${TEST_PREFIX}embedding_cache`);
    expect(meta.collectionName).toBe(`${TEST_PREFIX}meta`);
  });
});
