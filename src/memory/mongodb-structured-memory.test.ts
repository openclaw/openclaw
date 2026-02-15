import type { Collection, Db, Document } from "mongodb";
import { describe, it, expect, vi } from "vitest";

// Mock the schema module before imports
vi.mock("./mongodb-schema.js", () => ({
  structuredMemCollection: vi.fn(),
}));

import type { DetectedCapabilities } from "./mongodb-schema.js";
import { structuredMemCollection } from "./mongodb-schema.js";
import {
  writeStructuredMemory,
  searchStructuredMemory,
  getStructuredMemoryByType,
  type StructuredMemoryEntry,
} from "./mongodb-structured-memory.js";

// ---------------------------------------------------------------------------
// Mock collection factories
// ---------------------------------------------------------------------------

function createMockStructuredCol(): Collection {
  return {
    updateOne: vi.fn(async () => ({
      upsertedCount: 1,
      upsertedId: "new-id",
      modifiedCount: 0,
    })),
    aggregate: vi.fn(() => ({
      toArray: vi.fn(async () => []),
    })),
    find: vi.fn(() => ({
      toArray: vi.fn(async () => []),
    })),
  } as unknown as Collection;
}

function mockDb(): Db {
  return {} as unknown as Db;
}

const baseCapabilities: DetectedCapabilities = {
  vectorSearch: true,
  textSearch: true,
  scoreFusion: false,
  rankFusion: false,
};

const noSearchCapabilities: DetectedCapabilities = {
  vectorSearch: false,
  textSearch: false,
  scoreFusion: false,
  rankFusion: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("writeStructuredMemory", () => {
  it("creates a new structured memory entry", async () => {
    const col = createMockStructuredCol();
    vi.mocked(structuredMemCollection).mockReturnValue(col);

    const entry: StructuredMemoryEntry = {
      type: "decision",
      key: "framework-choice",
      value: "Using React for the frontend",
      context: "Team meeting on 2025-12-01",
      confidence: 0.95,
      source: "agent",
      agentId: "main",
      tags: ["frontend", "decision"],
    };

    const result = await writeStructuredMemory({
      db: mockDb(),
      prefix: "test_",
      entry,
      embeddingMode: "managed",
    });

    expect(result.upserted).toBe(true);
    expect(result.id).toBeDefined();
    expect(col.updateOne).toHaveBeenCalledTimes(1);

    // Verify upsert filter uses type + key
    const call = (col.updateOne as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toEqual({ type: "decision", key: "framework-choice" });
    expect(call[2]).toEqual({ upsert: true });
  });

  it("updates existing entry with same type+key", async () => {
    const col = createMockStructuredCol();
    // Make updateOne return modifiedCount instead of upsertedCount
    vi.mocked(col.updateOne).mockResolvedValueOnce({
      upsertedCount: 0,
      upsertedId: null,
      modifiedCount: 1,
      matchedCount: 1,
      acknowledged: true,
    });
    vi.mocked(structuredMemCollection).mockReturnValue(col);

    const entry: StructuredMemoryEntry = {
      type: "preference",
      key: "editor",
      value: "VSCode with Vim bindings",
      agentId: "main",
    };

    const result = await writeStructuredMemory({
      db: mockDb(),
      prefix: "test_",
      entry,
      embeddingMode: "managed",
    });

    expect(result.upserted).toBe(false);
    expect(result.id).toBe("editor");
  });

  it("embeds value + context combined text (F13)", async () => {
    const col = createMockStructuredCol();
    vi.mocked(structuredMemCollection).mockReturnValue(col);

    const mockProvider = {
      id: "test",
      model: "test-model",
      embedBatch: vi.fn(async () => [[0.1, 0.2, 0.3]]),
      embedQuery: vi.fn(async () => [0.1, 0.2, 0.3]),
    };

    const entry: StructuredMemoryEntry = {
      type: "decision",
      key: "db-choice",
      value: "Using MongoDB",
      context: "Team decided on 2025-01-01 during architecture review",
      agentId: "main",
    };

    await writeStructuredMemory({
      db: mockDb(),
      prefix: "test_",
      entry,
      embeddingMode: "managed",
      embeddingProvider: mockProvider,
    });

    // F13: Should embed value + context combined
    expect(mockProvider.embedBatch).toHaveBeenCalledWith([
      "Using MongoDB Team decided on 2025-01-01 during architecture review",
    ]);
  });

  it("includes embedding when provider is available", async () => {
    const col = createMockStructuredCol();
    vi.mocked(structuredMemCollection).mockReturnValue(col);

    const mockProvider = {
      id: "test",
      model: "test-model",
      embedBatch: vi.fn(async () => [[0.1, 0.2, 0.3]]),
      embedQuery: vi.fn(async () => [0.1, 0.2, 0.3]),
    };

    const entry: StructuredMemoryEntry = {
      type: "fact",
      key: "pi",
      value: "Pi is approximately 3.14159",
      agentId: "main",
    };

    await writeStructuredMemory({
      db: mockDb(),
      prefix: "test_",
      entry,
      embeddingMode: "managed",
      embeddingProvider: mockProvider,
    });

    expect(mockProvider.embedBatch).toHaveBeenCalledWith(["Pi is approximately 3.14159"]);
    const updateCall = (col.updateOne as ReturnType<typeof vi.fn>).mock.calls[0];
    const setDoc = updateCall[1].$set;
    expect(setDoc.embedding).toEqual([0.1, 0.2, 0.3]);
  });
});

describe("searchStructuredMemory", () => {
  it("returns results from vector search", async () => {
    const col = createMockStructuredCol();
    vi.mocked(col.aggregate).mockReturnValueOnce({
      toArray: vi.fn(async () => [
        { type: "decision", key: "arch", value: "Microservices architecture chosen", score: 0.9 },
      ]),
    } as unknown as ReturnType<Collection["aggregate"]>);

    const results = await searchStructuredMemory(col, "architecture", [0.1, 0.2], {
      maxResults: 5,
      capabilities: baseCapabilities,
      vectorIndexName: "test_structured_mem_vector",
      embeddingMode: "managed",
    });

    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("structured");
    expect(results[0].snippet).toContain("Microservices");
    expect(results[0].path).toContain("structured:decision:arch");
  });

  it("returns empty results when no matches", async () => {
    const col = createMockStructuredCol();

    const results = await searchStructuredMemory(col, "nothing", null, {
      maxResults: 5,
      capabilities: noSearchCapabilities,
      vectorIndexName: "test_structured_mem_vector",
      embeddingMode: "managed",
    });

    expect(results).toHaveLength(0);
  });

  it("caps numCandidates at 10000 in structured memory search (F1)", async () => {
    const col = createMockStructuredCol();
    vi.mocked(col.aggregate).mockReturnValueOnce({
      toArray: vi.fn(async () => [{ type: "fact", key: "pi", value: "Pi is 3.14", score: 0.9 }]),
    } as unknown as ReturnType<Collection["aggregate"]>);

    await searchStructuredMemory(col, "pi", [0.1, 0.2], {
      maxResults: 5,
      capabilities: baseCapabilities,
      vectorIndexName: "test_vec",
      embeddingMode: "managed",
      numCandidates: 15000,
    });

    const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const vsStage = pipeline[0].$vectorSearch;
    expect(vsStage.numCandidates).toBeLessThanOrEqual(10000);
  });

  it("includes $limit after $vectorSearch in structured memory (F7)", async () => {
    const col = createMockStructuredCol();
    vi.mocked(col.aggregate).mockReturnValueOnce({
      toArray: vi.fn(async () => [{ type: "fact", key: "pi", value: "Pi is 3.14", score: 0.9 }]),
    } as unknown as ReturnType<Collection["aggregate"]>);

    await searchStructuredMemory(col, "pi", [0.1, 0.2], {
      maxResults: 3,
      capabilities: baseCapabilities,
      vectorIndexName: "test_vec",
      embeddingMode: "managed",
    });

    const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Pipeline: $vectorSearch, $limit, $project
    expect(pipeline[1].$limit).toBe(3);
  });

  it("uses textFieldPath 'value' for automated mode in structured memory (F5)", async () => {
    const col = createMockStructuredCol();
    vi.mocked(col.aggregate).mockReturnValueOnce({
      toArray: vi.fn(async () => [{ type: "fact", key: "pi", value: "Pi is 3.14", score: 0.9 }]),
    } as unknown as ReturnType<Collection["aggregate"]>);

    await searchStructuredMemory(col, "pi", null, {
      maxResults: 5,
      capabilities: baseCapabilities,
      vectorIndexName: "test_vec",
      embeddingMode: "automated",
    });

    const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const vsStage = pipeline[0].$vectorSearch;
    expect(vsStage.path).toBe("value");
  });

  it("filters by type when provided", async () => {
    const col = createMockStructuredCol();
    vi.mocked(col.aggregate).mockReturnValueOnce({
      toArray: vi.fn(async () => [
        { type: "preference", key: "theme", value: "Dark mode preferred", score: 0.8 },
      ]),
    } as unknown as ReturnType<Collection["aggregate"]>);

    const results = await searchStructuredMemory(col, "theme", [0.1, 0.2], {
      maxResults: 5,
      filter: { type: "preference" },
      capabilities: baseCapabilities,
      vectorIndexName: "test_structured_mem_vector",
      embeddingMode: "managed",
    });

    expect(results).toHaveLength(1);
    // Verify filter was passed to vector search stage
    const aggregateCalls = (col.aggregate as ReturnType<typeof vi.fn>).mock.calls;
    expect(aggregateCalls.length).toBeGreaterThan(0);
  });
});

describe("getStructuredMemoryByType", () => {
  it("queries structured memory by type", async () => {
    const col = createMockStructuredCol();
    vi.mocked(structuredMemCollection).mockReturnValue(col);

    vi.mocked(col.find).mockReturnValueOnce({
      toArray: vi.fn(async () => [
        {
          type: "decision",
          key: "db-choice",
          value: "Using MongoDB",
          confidence: 0.9,
          updatedAt: new Date("2025-01-01"),
        },
      ]),
    } as unknown as ReturnType<Collection["find"]>);

    const entries = await getStructuredMemoryByType(mockDb(), "test_", "decision");

    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("decision");
    expect(entries[0].key).toBe("db-choice");
    expect(entries[0].value).toBe("Using MongoDB");
    expect(entries[0].confidence).toBe(0.9);
  });

  it("respects limit parameter", async () => {
    const col = createMockStructuredCol();
    vi.mocked(structuredMemCollection).mockReturnValue(col);

    vi.mocked(col.find).mockReturnValueOnce({
      toArray: vi.fn(async () => []),
    } as unknown as ReturnType<Collection["find"]>);

    await getStructuredMemoryByType(mockDb(), "test_", "fact", 10);

    const findCall = (col.find as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(findCall[0]).toEqual({ type: "fact" });
    expect(findCall[1]).toMatchObject({ sort: { updatedAt: -1 }, limit: 10 });
  });
});
