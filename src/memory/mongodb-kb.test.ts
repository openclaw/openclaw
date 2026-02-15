import type { Collection, Db } from "mongodb";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the schema module before imports
vi.mock("./mongodb-schema.js", () => ({
  kbCollection: vi.fn(),
  kbChunksCollection: vi.fn(),
}));

import { hashText } from "./internal.js";
import {
  ingestToKB,
  ingestFilesToKB,
  listKBDocuments,
  removeKBDocument,
  getKBStats,
  type KBDocument,
} from "./mongodb-kb.js";
import { kbCollection, kbChunksCollection } from "./mongodb-schema.js";

// ---------------------------------------------------------------------------
// Mock collection factories
// ---------------------------------------------------------------------------

function createMockKBCol(): Collection {
  const docs: Record<string, unknown>[] = [];
  return {
    findOne: vi.fn(async (filter: Record<string, unknown>) => {
      return docs.find((d) => d.hash === filter.hash) ?? null;
    }),
    insertOne: vi.fn(async (doc: Record<string, unknown>) => {
      docs.push(doc);
      return { insertedId: doc._id };
    }),
    deleteOne: vi.fn(async () => ({ deletedCount: 1 })),
    find: vi.fn(() => ({
      toArray: vi.fn(async () => docs),
    })),
    countDocuments: vi.fn(async () => docs.length),
    distinct: vi.fn(async () => []),
    aggregate: vi.fn(() => ({
      toArray: vi.fn(async () => []),
    })),
  } as unknown as Collection;
}

function createMockKBChunksCol(): Collection {
  return {
    bulkWrite: vi.fn(async (ops: unknown[]) => ({
      upsertedCount: ops.length,
      modifiedCount: 0,
    })),
    deleteMany: vi.fn(async () => ({ deletedCount: 0 })),
    countDocuments: vi.fn(async () => 0),
  } as unknown as Collection;
}

function mockDb(): Db {
  return {} as unknown as Db;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let mockKB: Collection;
let mockKBChunks: Collection;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawmongo-kb-test-"));
  mockKB = createMockKBCol();
  mockKBChunks = createMockKBChunksCol();
  vi.mocked(kbCollection).mockReturnValue(mockKB);
  vi.mocked(kbChunksCollection).mockReturnValue(mockKBChunks);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ingestToKB", () => {
  it("ingests a single document and creates chunks", async () => {
    const doc: KBDocument = {
      title: "Test Doc",
      content: "This is test content for the knowledge base.\n\nIt has multiple paragraphs.",
      source: { type: "manual", importedBy: "agent" },
      tags: ["test"],
      category: "testing",
      hash: hashText("This is test content for the knowledge base.\n\nIt has multiple paragraphs."),
    };

    const result = await ingestToKB({
      db: mockDb(),
      prefix: "test_",
      documents: [doc],
      embeddingMode: "managed",
    });

    expect(result.documentsProcessed).toBe(1);
    expect(result.chunksCreated).toBeGreaterThan(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(mockKB.insertOne).toHaveBeenCalledTimes(1);
    expect(mockKBChunks.bulkWrite).toHaveBeenCalledTimes(1);
  });

  it("skips document with same hash (dedup)", async () => {
    const content = "Duplicate content";
    const hash = hashText(content);
    const doc: KBDocument = {
      title: "Dupe",
      content,
      source: { type: "manual", importedBy: "agent" },
      hash,
    };

    // First, make findOne return existing doc with same hash
    vi.mocked(mockKB.findOne).mockResolvedValueOnce({ _id: "existing-id", hash });

    const result = await ingestToKB({
      db: mockDb(),
      prefix: "test_",
      documents: [doc],
      embeddingMode: "managed",
    });

    expect(result.documentsProcessed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockKB.insertOne).not.toHaveBeenCalled();
  });

  it("force re-ingests even with same hash", async () => {
    const content = "Force content";
    const hash = hashText(content);
    const doc: KBDocument = {
      title: "Force",
      content,
      source: { type: "manual", importedBy: "agent" },
      hash,
    };

    // findOne returns existing doc
    vi.mocked(mockKB.findOne).mockResolvedValueOnce({ _id: "old-id", hash });

    const result = await ingestToKB({
      db: mockDb(),
      prefix: "test_",
      documents: [doc],
      embeddingMode: "managed",
      force: true,
    });

    expect(result.documentsProcessed).toBe(1);
    expect(result.skipped).toBe(0);
    // Should delete old doc+chunks and insert new
    expect(mockKBChunks.deleteMany).toHaveBeenCalled();
    expect(mockKB.deleteOne).toHaveBeenCalled();
    expect(mockKB.insertOne).toHaveBeenCalled();
  });

  it("deduplicates by source.path first, then hash (F10)", async () => {
    const content = "Original content";
    const doc: KBDocument = {
      title: "Path Dedup",
      content,
      source: { type: "file", path: "/docs/guide.md", importedBy: "cli" },
      hash: hashText(content),
    };

    // Mock findOne to return existing doc by path with same hash
    vi.mocked(mockKB.findOne).mockResolvedValueOnce({
      _id: "existing-id",
      hash: doc.hash,
      "source.path": "/docs/guide.md",
    });

    const result = await ingestToKB({
      db: mockDb(),
      prefix: "test_",
      documents: [doc],
      embeddingMode: "managed",
    });

    expect(result.skipped).toBe(1);
    expect(result.documentsProcessed).toBe(0);
  });

  it("replaces old version when source.path matches but hash changed (F10)", async () => {
    const oldHash = hashText("Old content");
    const newContent = "New updated content";
    const doc: KBDocument = {
      title: "Updated Doc",
      content: newContent,
      source: { type: "file", path: "/docs/guide.md", importedBy: "cli" },
      hash: hashText(newContent),
    };

    // Mock findOne to return existing doc by path with DIFFERENT hash
    vi.mocked(mockKB.findOne).mockResolvedValueOnce({
      _id: "old-id",
      hash: oldHash,
      "source.path": "/docs/guide.md",
    });

    const result = await ingestToKB({
      db: mockDb(),
      prefix: "test_",
      documents: [doc],
      embeddingMode: "managed",
    });

    expect(result.documentsProcessed).toBe(1);
    // Should delete old doc+chunks before inserting new
    expect(mockKBChunks.deleteMany).toHaveBeenCalledWith({ docId: "old-id" });
    expect(mockKB.deleteOne).toHaveBeenCalled();
  });

  it("handles empty content gracefully", async () => {
    const doc: KBDocument = {
      title: "Empty",
      content: "",
      source: { type: "manual", importedBy: "agent" },
      hash: hashText(""),
    };

    const result = await ingestToKB({
      db: mockDb(),
      prefix: "test_",
      documents: [doc],
      embeddingMode: "managed",
    });

    expect(result.documentsProcessed).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("reports progress during ingestion", async () => {
    const docs: KBDocument[] = [
      {
        title: "Doc 1",
        content: "Content 1",
        source: { type: "manual", importedBy: "agent" },
        hash: hashText("Content 1"),
      },
      {
        title: "Doc 2",
        content: "Content 2",
        source: { type: "manual", importedBy: "agent" },
        hash: hashText("Content 2"),
      },
    ];

    const progressUpdates: Array<{ completed: number; total: number; label: string }> = [];
    await ingestToKB({
      db: mockDb(),
      prefix: "test_",
      documents: docs,
      embeddingMode: "managed",
      progress: (update) => progressUpdates.push(update),
    });

    // Should have progress updates for each doc + final "Done"
    expect(progressUpdates.length).toBeGreaterThanOrEqual(3);
    expect(progressUpdates[progressUpdates.length - 1].label).toBe("Done");
  });
});

describe("ingestFilesToKB", () => {
  it("ingests .md files from a directory", async () => {
    const docsDir = path.join(tmpDir, "docs");
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, "guide.md"), "# Guide\nSome guide content");
    await fs.writeFile(path.join(docsDir, "notes.txt"), "Some plain text notes");
    await fs.writeFile(path.join(docsDir, "ignore.js"), "console.log('skip')");

    const result = await ingestFilesToKB({
      db: mockDb(),
      prefix: "test_",
      paths: [docsDir],
      importedBy: "cli",
      embeddingMode: "managed",
    });

    // Should process .md and .txt but skip .js
    expect(result.documentsProcessed).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  it("handles missing paths gracefully", async () => {
    const result = await ingestFilesToKB({
      db: mockDb(),
      prefix: "test_",
      paths: ["/nonexistent/path"],
      importedBy: "cli",
      embeddingMode: "managed",
    });

    expect(result.documentsProcessed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("ingests single file path", async () => {
    const filePath = path.join(tmpDir, "single.md");
    await fs.writeFile(filePath, "# Single file\nContent here");

    const result = await ingestFilesToKB({
      db: mockDb(),
      prefix: "test_",
      paths: [filePath],
      importedBy: "agent",
      embeddingMode: "managed",
      tags: ["auto"],
      category: "docs",
    });

    expect(result.documentsProcessed).toBe(1);
  });
});

describe("listKBDocuments", () => {
  it("returns list of KB documents", async () => {
    const docs = await listKBDocuments(mockDb(), "test_");
    expect(Array.isArray(docs)).toBe(true);
  });
});

describe("removeKBDocument", () => {
  it("removes a KB document and its chunks (sequential fallback)", async () => {
    const removed = await removeKBDocument(mockDb(), "test_", "doc-123");
    expect(removed).toBe(true);
    expect(mockKBChunks.deleteMany).toHaveBeenCalledWith({ docId: "doc-123" });
    expect(mockKB.deleteOne).toHaveBeenCalled();
  });

  it("uses transaction when client is provided (F11)", async () => {
    const sessionMock = {
      withTransaction: vi.fn(async (fn: () => Promise<void>) => fn()),
      endSession: vi.fn(),
    };
    const clientMock = {
      startSession: vi.fn(() => sessionMock),
    };

    const removed = await removeKBDocument(
      mockDb(),
      "test_",
      "doc-tx",
      clientMock as unknown as import("mongodb").MongoClient,
    );
    expect(removed).toBe(true);
    expect(clientMock.startSession).toHaveBeenCalled();
    expect(sessionMock.withTransaction).toHaveBeenCalled();
    expect(sessionMock.endSession).toHaveBeenCalled();
  });

  it("falls back to sequential on transaction failure (F11)", async () => {
    const sessionMock = {
      withTransaction: vi.fn(async () => {
        throw new Error("not a replica set");
      }),
      endSession: vi.fn(),
    };
    const clientMock = {
      startSession: vi.fn(() => sessionMock),
    };

    const removed = await removeKBDocument(
      mockDb(),
      "test_",
      "doc-fallback",
      clientMock as unknown as import("mongodb").MongoClient,
    );
    expect(removed).toBe(true);
    // Should still delete via sequential fallback
    expect(mockKBChunks.deleteMany).toHaveBeenCalledWith({ docId: "doc-fallback" });
    expect(mockKB.deleteOne).toHaveBeenCalled();
  });
});

describe("getKBStats", () => {
  it("returns document and chunk counts", async () => {
    const stats = await getKBStats(mockDb(), "test_");
    expect(stats).toHaveProperty("documents");
    expect(stats).toHaveProperty("chunks");
    expect(stats).toHaveProperty("categories");
    expect(stats).toHaveProperty("sources");
    expect(typeof stats.documents).toBe("number");
    expect(typeof stats.chunks).toBe("number");
  });
});
