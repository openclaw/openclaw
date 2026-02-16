import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock @azure/data-tables before importing the module under test
// ---------------------------------------------------------------------------

const mockListEntities = vi.fn();
const mockUpsertEntity = vi.fn();
const mockDeleteEntity = vi.fn();
const mockGetEntity = vi.fn();
const mockCreateTable = vi.fn();

vi.mock("@azure/data-tables", () => ({
  TableClient: {
    fromConnectionString: () => ({
      listEntities: mockListEntities,
      upsertEntity: mockUpsertEntity,
      deleteEntity: mockDeleteEntity,
      getEntity: mockGetEntity,
    }),
  },
  TableServiceClient: {
    fromConnectionString: () => ({
      createTable: mockCreateTable,
    }),
  },
}));

import { AzureTableMemoryProvider } from "./memory-provider-azure.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setConnectionString(cs = "DefaultEndpointsProtocol=https;AccountName=test") {
  vi.stubEnv("AZURE_STORAGE_CONNECTION_STRING", cs);
}

async function* asyncIterator<T>(items: T[]): AsyncIterableIterator<T> {
  for (const item of items) {
    yield item;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AzureTableMemoryProvider", () => {
  beforeEach(() => {
    setConnectionString();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  it("throws when AZURE_STORAGE_CONNECTION_STRING is not set", () => {
    vi.unstubAllEnvs();
    delete process.env.AZURE_STORAGE_CONNECTION_STRING;
    expect(() => new AzureTableMemoryProvider("agent-1")).toThrow(
      /AZURE_STORAGE_CONNECTION_STRING/,
    );
  });

  it("constructs with a valid connection string", () => {
    const provider = new AzureTableMemoryProvider("agent-1");
    expect(provider).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // search
  // -------------------------------------------------------------------------

  describe("search", () => {
    it("returns scored results matching query tokens", async () => {
      const provider = new AzureTableMemoryProvider("agent-1");
      mockListEntities.mockReturnValue(
        asyncIterator([
          {
            partitionKey: "agent-1",
            rowKey: "chunk-1",
            path: "file.ts",
            source: "memory",
            startLine: 1,
            endLine: 10,
            text: "hello world function",
          },
          {
            partitionKey: "agent-1",
            rowKey: "chunk-2",
            path: "other.ts",
            source: "memory",
            startLine: 1,
            endLine: 5,
            text: "unrelated content",
          },
        ]),
      );

      const results = await provider.search("hello function");
      expect(results.length).toBe(1);
      expect(results[0].path).toBe("file.ts");
      expect(results[0].score).toBeGreaterThan(0);
    });

    it("returns empty array for empty query", async () => {
      const provider = new AzureTableMemoryProvider("agent-1");
      const results = await provider.search("");
      expect(results).toEqual([]);
    });

    it("respects maxResults", async () => {
      const provider = new AzureTableMemoryProvider("agent-1");
      mockListEntities.mockReturnValue(
        asyncIterator(
          Array.from({ length: 20 }, (_, i) => ({
            partitionKey: "agent-1",
            rowKey: `chunk-${i}`,
            path: `file-${i}.ts`,
            source: "memory",
            startLine: 1,
            endLine: 5,
            text: "matching keyword content",
          })),
        ),
      );

      const results = await provider.search("matching keyword", { maxResults: 3 });
      expect(results.length).toBe(3);
    });

    it("filters results below minScore", async () => {
      const provider = new AzureTableMemoryProvider("agent-1");
      mockListEntities.mockReturnValue(
        asyncIterator([
          {
            partitionKey: "agent-1",
            rowKey: "chunk-1",
            path: "file.ts",
            source: "memory",
            startLine: 1,
            endLine: 5,
            text: "completely unrelated text with no overlap",
          },
        ]),
      );

      const results = await provider.search("specific query terms", { minScore: 0.5 });
      expect(results).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // readFile
  // -------------------------------------------------------------------------

  describe("readFile", () => {
    it("concatenates chunks for a path", async () => {
      const provider = new AzureTableMemoryProvider("agent-1");
      mockListEntities.mockReturnValue(
        asyncIterator([
          { partitionKey: "agent-1", rowKey: "c1", text: "line one" },
          { partitionKey: "agent-1", rowKey: "c2", text: "line two" },
        ]),
      );

      const result = await provider.readFile({ relPath: "file.ts" });
      expect(result.text).toBe("line one\nline two");
      expect(result.path).toBe("file.ts");
    });

    it("supports line range slicing", async () => {
      const provider = new AzureTableMemoryProvider("agent-1");
      mockListEntities.mockReturnValue(
        asyncIterator([{ partitionKey: "agent-1", rowKey: "c1", text: "a\nb\nc\nd" }]),
      );

      const result = await provider.readFile({ relPath: "file.ts", from: 1, lines: 2 });
      expect(result.text).toBe("b\nc");
    });
  });

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------

  describe("status", () => {
    it("reports azure-table-storage provider", () => {
      const provider = new AzureTableMemoryProvider("agent-1");
      const s = provider.status();
      expect(s.provider).toBe("azure-table-storage");
      expect(s.backend).toBe("builtin");
      expect(s.vector?.enabled).toBe(false);
      expect(s.fts?.enabled).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // upsert / delete helpers
  // -------------------------------------------------------------------------

  describe("upsertChunk", () => {
    it("calls upsertEntity with correct entity shape", async () => {
      const provider = new AzureTableMemoryProvider("agent-1");
      await provider.upsertChunk({
        id: "c1",
        path: "file.ts",
        source: "memory",
        startLine: 1,
        endLine: 10,
        hash: "abc",
        model: "text-embedding",
        text: "hello world",
        embedding: [0.1, 0.2, 0.3],
      });

      expect(mockUpsertEntity).toHaveBeenCalledTimes(1);
      const entity = mockUpsertEntity.mock.calls[0][0];
      expect(entity.partitionKey).toBe("agent-1");
      expect(entity.path).toBe("file.ts");
      expect(entity.text).toBe("hello world");
      expect(JSON.parse(entity.embedding)).toEqual([0.1, 0.2, 0.3]);
    });
  });

  describe("upsertFile", () => {
    it("calls upsertEntity for files table", async () => {
      const provider = new AzureTableMemoryProvider("agent-1");
      await provider.upsertFile({
        path: "src/index.ts",
        source: "memory",
        hash: "deadbeef",
        mtime: Date.now(),
        size: 1234,
      });

      expect(mockUpsertEntity).toHaveBeenCalledTimes(1);
      const entity = mockUpsertEntity.mock.calls[0][0];
      expect(entity.partitionKey).toBe("agent-1");
      expect(entity.hash).toBe("deadbeef");
    });
  });

  describe("deleteChunksByPath", () => {
    it("deletes all chunks matching path and source", async () => {
      const provider = new AzureTableMemoryProvider("agent-1");
      mockListEntities.mockReturnValue(
        asyncIterator([
          { partitionKey: "agent-1", rowKey: "c1" },
          { partitionKey: "agent-1", rowKey: "c2" },
        ]),
      );

      await provider.deleteChunksByPath("old-file.ts", "memory");
      expect(mockDeleteEntity).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // meta
  // -------------------------------------------------------------------------

  describe("meta operations", () => {
    it("upserts and gets meta values", async () => {
      const provider = new AzureTableMemoryProvider("agent-1");

      await provider.upsertMeta("version", "1.0");
      expect(mockUpsertEntity).toHaveBeenCalledTimes(1);

      mockGetEntity.mockResolvedValue({ value: "1.0" });
      const value = await provider.getMeta("version");
      expect(value).toBe("1.0");
    });

    it("returns undefined for missing meta", async () => {
      const provider = new AzureTableMemoryProvider("agent-1");
      mockGetEntity.mockRejectedValue({ statusCode: 404 });

      const value = await provider.getMeta("nonexistent");
      expect(value).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // embedding cache
  // -------------------------------------------------------------------------

  describe("embedding cache", () => {
    it("upserts and retrieves cached embeddings", async () => {
      const provider = new AzureTableMemoryProvider("agent-1");
      await provider.upsertEmbeddingCache({
        provider: "openai",
        model: "text-embedding-3-small",
        providerKey: "key1",
        hash: "abc123",
        embedding: [0.1, 0.2],
        dims: 2,
      });
      expect(mockUpsertEntity).toHaveBeenCalledTimes(1);

      mockGetEntity.mockResolvedValue({ embedding: "[0.1,0.2]" });
      const cached = await provider.getEmbeddingCache("openai", "text-embedding-3-small", "abc123");
      expect(cached).toEqual([0.1, 0.2]);
    });

    it("returns undefined for cache miss", async () => {
      const provider = new AzureTableMemoryProvider("agent-1");
      mockGetEntity.mockRejectedValue({ statusCode: 404 });

      const cached = await provider.getEmbeddingCache("openai", "model", "miss");
      expect(cached).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // probes & lifecycle
  // -------------------------------------------------------------------------

  describe("probes", () => {
    it("reports embeddings not available", async () => {
      const provider = new AzureTableMemoryProvider("agent-1");
      const result = await provider.probeEmbeddingAvailability();
      expect(result.ok).toBe(false);
    });

    it("reports vector search not available", async () => {
      const provider = new AzureTableMemoryProvider("agent-1");
      const available = await provider.probeVectorAvailability();
      expect(available).toBe(false);
    });
  });

  describe("sync", () => {
    it("is a no-op that calls progress callback", async () => {
      const provider = new AzureTableMemoryProvider("agent-1");
      const progress = vi.fn();
      await provider.sync({ progress });
      expect(progress).toHaveBeenCalledWith({ completed: 1, total: 1, label: "azure-table-sync" });
    });
  });

  describe("close", () => {
    it("resolves without error", async () => {
      const provider = new AzureTableMemoryProvider("agent-1");
      await expect(provider.close()).resolves.toBeUndefined();
    });
  });

  describe("ensureTables", () => {
    it("creates all required tables", async () => {
      const provider = new AzureTableMemoryProvider("agent-1");
      mockCreateTable.mockResolvedValue(undefined);
      await provider.ensureTables();
      expect(mockCreateTable).toHaveBeenCalledTimes(4);
    });
  });
});
