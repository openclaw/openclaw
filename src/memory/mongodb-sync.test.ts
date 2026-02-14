import type { Db } from "mongodb";
import type { Collection } from "mongodb";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the schema module before imports (vi.mock is hoisted)
vi.mock("./mongodb-schema.js", () => ({
  chunksCollection: vi.fn(),
  filesCollection: vi.fn(),
}));

vi.mock("./session-files.js", () => ({
  listSessionFilesForAgent: vi.fn(async () => []),
  buildSessionEntry: vi.fn(async () => null),
  sessionPathForFile: vi.fn((absPath: string) => `sessions/${path.basename(absPath)}`),
}));

import { chunksCollection, filesCollection } from "./mongodb-schema.js";
import { syncToMongoDB } from "./mongodb-sync.js";
import { listSessionFilesForAgent, buildSessionEntry } from "./session-files.js";

// ---------------------------------------------------------------------------
// Mock collection factories
// ---------------------------------------------------------------------------

function createMockChunksCol(): ReturnType<typeof vi.fn> & Collection {
  const col = {
    find: vi.fn(() => ({
      toArray: vi.fn(async () => []),
    })),
    bulkWrite: vi.fn(async (ops: unknown[]) => ({
      upsertedCount: ops.length,
      modifiedCount: 0,
    })),
    deleteMany: vi.fn(async () => ({ deletedCount: 0 })),
    distinct: vi.fn(async () => [] as string[]),
  };
  return col as unknown as ReturnType<typeof vi.fn> & Collection;
}

function createMockFilesCol(
  storedFiles: Map<string, { hash: string; mtime: number; size: number }> = new Map(),
): Collection {
  const docs = Array.from(storedFiles.entries()).map(([filePath, data]) => ({
    _id: filePath,
    ...data,
  }));
  return {
    find: vi.fn(() => ({
      toArray: vi.fn(async () => docs),
    })),
    updateOne: vi.fn(async () => ({})),
    deleteOne: vi.fn(async () => ({ deletedCount: 1 })),
  } as unknown as Collection;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let mockChunks: Collection;
let mockFiles: Collection;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawmongo-sync-test-"));
  mockChunks = createMockChunksCol();
  mockFiles = createMockFilesCol();
  vi.mocked(chunksCollection).mockReturnValue(mockChunks);
  vi.mocked(filesCollection).mockReturnValue(mockFiles);
  // Reset session mocks to defaults (no sessions)
  vi.mocked(listSessionFilesForAgent).mockResolvedValue([]);
  vi.mocked(buildSessionEntry).mockResolvedValue(null);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeMemoryFiles(
  workspaceDir: string,
  files: Record<string, string>,
): Promise<void> {
  const memDir = path.join(workspaceDir, "memory");
  await fs.mkdir(memDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(memDir, name), content, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("syncToMongoDB", () => {
  it("syncs memory files from disk to MongoDB", async () => {
    await writeMemoryFiles(tmpDir, {
      "test.md": "# Test\n\nHello world content here for chunking",
      "notes.md": "# Notes\n\nSome notes here for indexing",
    });

    const result = await syncToMongoDB({
      db: {} as Db,
      prefix: "test_",
      workspaceDir: tmpDir,
      embeddingMode: "automated",
    });

    expect(result.filesProcessed).toBe(2);
    expect(result.chunksUpserted).toBeGreaterThanOrEqual(2);
    expect(mockChunks.bulkWrite).toHaveBeenCalled();
    expect(mockFiles.updateOne).toHaveBeenCalled();
  });

  it("returns zero when no memory files exist", async () => {
    const result = await syncToMongoDB({
      db: {} as Db,
      prefix: "test_",
      workspaceDir: tmpDir,
      embeddingMode: "automated",
    });

    expect(result.filesProcessed).toBe(0);
    expect(result.chunksUpserted).toBe(0);
    expect(result.staleDeleted).toBe(0);
  });

  it("skips unchanged files based on hash comparison", async () => {
    await writeMemoryFiles(tmpDir, {
      "test.md": "# Test\n\nHello world",
    });

    // First sync: file is new
    const result1 = await syncToMongoDB({
      db: {} as Db,
      prefix: "test_",
      workspaceDir: tmpDir,
      embeddingMode: "automated",
    });
    expect(result1.filesProcessed).toBe(1);

    // Extract the hash from the upserted file metadata
    const updateCall = (mockFiles.updateOne as ReturnType<typeof vi.fn>).mock.calls[0];
    const fileHash = updateCall[1].$set.hash;

    // Rebuild mock files collection with stored hash
    const storedFiles = new Map([["memory/test.md", { hash: fileHash, mtime: 0, size: 0 }]]);
    mockFiles = createMockFilesCol(storedFiles);
    vi.mocked(filesCollection).mockReturnValue(mockFiles);

    // Reset chunks bulkWrite tracking
    mockChunks = createMockChunksCol();
    vi.mocked(chunksCollection).mockReturnValue(mockChunks);

    // Second sync: file unchanged
    const result2 = await syncToMongoDB({
      db: {} as Db,
      prefix: "test_",
      workspaceDir: tmpDir,
      embeddingMode: "automated",
    });
    expect(result2.filesProcessed).toBe(0);
    expect(mockChunks.bulkWrite).not.toHaveBeenCalled();
  });

  it("forces re-index when force=true", async () => {
    await writeMemoryFiles(tmpDir, {
      "test.md": "# Test\n\nContent",
    });

    // Pretend file is already stored
    const storedFiles = new Map([
      ["memory/test.md", { hash: "matches_everything", mtime: 0, size: 0 }],
    ]);
    mockFiles = createMockFilesCol(storedFiles);
    vi.mocked(filesCollection).mockReturnValue(mockFiles);

    const result = await syncToMongoDB({
      db: {} as Db,
      prefix: "test_",
      workspaceDir: tmpDir,
      embeddingMode: "automated",
      force: true,
    });

    expect(result.filesProcessed).toBe(1);
  });

  it("does not include embedding field in automated mode", async () => {
    await writeMemoryFiles(tmpDir, {
      "test.md": "# Test\n\nContent here for automated mode",
    });

    await syncToMongoDB({
      db: {} as Db,
      prefix: "test_",
      workspaceDir: tmpDir,
      embeddingMode: "automated",
    });

    const bulkOps = (mockChunks.bulkWrite as ReturnType<typeof vi.fn>).mock.calls[0][0];
    for (const op of bulkOps) {
      // In automated mode, MongoDB handles embeddings — no embedding field in document
      expect(op.updateOne.update.$set.embedding).toBeUndefined();
    }
  });

  it("includes embedding field in managed mode when provider available", async () => {
    await writeMemoryFiles(tmpDir, {
      "test.md": "# Test\n\nContent for managed embedding",
    });

    const mockProvider = {
      id: "mock",
      model: "mock-model",
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
      embedQuery: vi.fn(async () => [0.1, 0.2, 0.3]),
    };

    await syncToMongoDB({
      db: {} as Db,
      prefix: "test_",
      workspaceDir: tmpDir,
      embeddingMode: "managed",
      embeddingProvider: mockProvider,
      model: "mock-model",
    });

    expect(mockProvider.embedBatch).toHaveBeenCalled();
    const bulkOps = (mockChunks.bulkWrite as ReturnType<typeof vi.fn>).mock.calls[0][0];
    for (const op of bulkOps) {
      expect(op.updateOne.update.$set.embedding).toEqual([0.1, 0.2, 0.3]);
    }
  });

  it("reports progress during sync", async () => {
    await writeMemoryFiles(tmpDir, {
      "a.md": "# A\n\nContent A for testing",
      "b.md": "# B\n\nContent B for testing",
    });

    const progressUpdates: Array<{ completed: number; total: number; label?: string }> = [];
    await syncToMongoDB({
      db: {} as Db,
      prefix: "test_",
      workspaceDir: tmpDir,
      embeddingMode: "automated",
      progress: (update) => progressUpdates.push(update),
    });

    // Should have at least initial + per-file progress updates
    expect(progressUpdates.length).toBeGreaterThanOrEqual(2);
    const last = progressUpdates[progressUpdates.length - 1];
    expect(last.completed).toBe(last.total);
  });

  it("deletes stale chunks for removed files", async () => {
    await writeMemoryFiles(tmpDir, {
      "keep.md": "# Keep\n\nKeep this file",
    });

    // Mock: chunks collection reports paths including a deleted file
    (mockChunks.distinct as ReturnType<typeof vi.fn>).mockResolvedValue([
      "memory/keep.md",
      "memory/deleted.md",
    ]);
    (mockChunks.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ deletedCount: 3 });

    const result = await syncToMongoDB({
      db: {} as Db,
      prefix: "test_",
      workspaceDir: tmpDir,
      embeddingMode: "automated",
    });

    expect(mockChunks.deleteMany).toHaveBeenCalledWith({
      path: { $in: ["memory/deleted.md"] },
    });
    expect(result.staleDeleted).toBe(3);
  });

  it("sets correct chunk document structure", async () => {
    await writeMemoryFiles(tmpDir, {
      "test.md": "# Test\n\nSome content for chunk structure test",
    });

    await syncToMongoDB({
      db: {} as Db,
      prefix: "test_",
      workspaceDir: tmpDir,
      embeddingMode: "automated",
    });

    const bulkOps = (mockChunks.bulkWrite as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(bulkOps.length).toBeGreaterThan(0);

    const firstOp = bulkOps[0].updateOne;
    // Check filter uses composite _id
    expect(typeof firstOp.filter._id).toBe("string");
    expect(firstOp.filter._id).toContain("memory/test.md:");

    // Check set fields
    const doc = firstOp.update.$set;
    expect(doc.path).toBe("memory/test.md");
    expect(doc.source).toBe("memory");
    expect(typeof doc.startLine).toBe("number");
    expect(typeof doc.endLine).toBe("number");
    expect(typeof doc.hash).toBe("string");
    expect(typeof doc.text).toBe("string");
    expect(doc.updatedAt).toBeInstanceOf(Date);
    expect(firstOp.upsert).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Session transcript syncing tests
// ---------------------------------------------------------------------------

describe("syncToMongoDB — session files", () => {
  it("syncs session files when agentId is provided", async () => {
    const sessionEntry = {
      path: "sessions/transcript.jsonl",
      absPath: "/tmp/sessions/transcript.jsonl",
      mtimeMs: Date.now(),
      size: 500,
      hash: "session-hash-abc",
      content: "User: How do I use MongoDB?\nAssistant: Use the driver.",
      lineMap: [1, 2],
    };

    vi.mocked(listSessionFilesForAgent).mockResolvedValue(["/tmp/sessions/transcript.jsonl"]);
    vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry);

    const result = await syncToMongoDB({
      db: {} as Db,
      prefix: "test_",
      workspaceDir: tmpDir,
      agentId: "agent-123",
      embeddingMode: "automated",
    });

    expect(result.sessionFilesProcessed).toBe(1);
    expect(result.sessionChunksUpserted).toBeGreaterThanOrEqual(1);
    expect(listSessionFilesForAgent).toHaveBeenCalledWith("agent-123");
    expect(buildSessionEntry).toHaveBeenCalledWith("/tmp/sessions/transcript.jsonl");
  });

  it("does not sync sessions when agentId is not provided", async () => {
    const result = await syncToMongoDB({
      db: {} as Db,
      prefix: "test_",
      workspaceDir: tmpDir,
      embeddingMode: "automated",
    });

    expect(result.sessionFilesProcessed).toBe(0);
    expect(result.sessionChunksUpserted).toBe(0);
    expect(listSessionFilesForAgent).not.toHaveBeenCalled();
  });

  it("stores session chunks with source='sessions'", async () => {
    const sessionEntry = {
      path: "sessions/chat.jsonl",
      absPath: "/tmp/sessions/chat.jsonl",
      mtimeMs: Date.now(),
      size: 300,
      hash: "session-hash-def",
      content: "User: Hello\nAssistant: Hi there!",
      lineMap: [1, 2],
    };

    vi.mocked(listSessionFilesForAgent).mockResolvedValue(["/tmp/sessions/chat.jsonl"]);
    vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry);

    await syncToMongoDB({
      db: {} as Db,
      prefix: "test_",
      workspaceDir: tmpDir,
      agentId: "agent-1",
      embeddingMode: "automated",
    });

    const bulkOps = (mockChunks.bulkWrite as ReturnType<typeof vi.fn>).mock.calls[0][0];
    for (const op of bulkOps) {
      expect(op.updateOne.update.$set.source).toBe("sessions");
      expect(op.updateOne.update.$set.path).toBe("sessions/chat.jsonl");
    }
  });

  it("stores session file metadata with source='sessions'", async () => {
    const sessionEntry = {
      path: "sessions/meta-test.jsonl",
      absPath: "/tmp/sessions/meta-test.jsonl",
      mtimeMs: 1700000000000,
      size: 200,
      hash: "session-meta-hash",
      content: "User: Test\nAssistant: Response",
      lineMap: [1, 2],
    };

    vi.mocked(listSessionFilesForAgent).mockResolvedValue(["/tmp/sessions/meta-test.jsonl"]);
    vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry);

    await syncToMongoDB({
      db: {} as Db,
      prefix: "test_",
      workspaceDir: tmpDir,
      agentId: "agent-1",
      embeddingMode: "automated",
    });

    // updateOne is called for session file metadata
    const updateCalls = (mockFiles.updateOne as ReturnType<typeof vi.fn>).mock.calls;
    const sessionCall = updateCalls.find((call) => call[0]._id === "sessions/meta-test.jsonl");
    expect(sessionCall).toBeDefined();
    expect(sessionCall![1].$set.source).toBe("sessions");
    expect(sessionCall![1].$set.hash).toBe("session-meta-hash");
  });

  it("skips unchanged session files based on hash", async () => {
    const sessionEntry = {
      path: "sessions/unchanged.jsonl",
      absPath: "/tmp/sessions/unchanged.jsonl",
      mtimeMs: Date.now(),
      size: 100,
      hash: "already-indexed-hash",
      content: "User: Repeat\nAssistant: Same",
      lineMap: [1, 2],
    };

    vi.mocked(listSessionFilesForAgent).mockResolvedValue(["/tmp/sessions/unchanged.jsonl"]);
    vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry);

    // Pre-populate stored files with matching hash
    mockFiles = createMockFilesCol(
      new Map([["sessions/unchanged.jsonl", { hash: "already-indexed-hash", mtime: 0, size: 0 }]]),
    );
    vi.mocked(filesCollection).mockReturnValue(mockFiles);

    const result = await syncToMongoDB({
      db: {} as Db,
      prefix: "test_",
      workspaceDir: tmpDir,
      agentId: "agent-1",
      embeddingMode: "automated",
    });

    expect(result.sessionFilesProcessed).toBe(0);
    expect(mockChunks.bulkWrite).not.toHaveBeenCalled();
  });

  it("force re-indexes session files", async () => {
    const sessionEntry = {
      path: "sessions/force-test.jsonl",
      absPath: "/tmp/sessions/force-test.jsonl",
      mtimeMs: Date.now(),
      size: 100,
      hash: "same-hash",
      content: "User: Force test\nAssistant: Forced",
      lineMap: [1, 2],
    };

    vi.mocked(listSessionFilesForAgent).mockResolvedValue(["/tmp/sessions/force-test.jsonl"]);
    vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry);

    // Pre-populate stored files with matching hash
    mockFiles = createMockFilesCol(
      new Map([["sessions/force-test.jsonl", { hash: "same-hash", mtime: 0, size: 0 }]]),
    );
    vi.mocked(filesCollection).mockReturnValue(mockFiles);

    const result = await syncToMongoDB({
      db: {} as Db,
      prefix: "test_",
      workspaceDir: tmpDir,
      agentId: "agent-1",
      embeddingMode: "automated",
      force: true,
    });

    expect(result.sessionFilesProcessed).toBe(1);
    expect(result.sessionChunksUpserted).toBeGreaterThanOrEqual(1);
  });

  it("skips null/empty session entries", async () => {
    vi.mocked(listSessionFilesForAgent).mockResolvedValue([
      "/tmp/sessions/null.jsonl",
      "/tmp/sessions/empty.jsonl",
    ]);
    vi.mocked(buildSessionEntry).mockResolvedValueOnce(null).mockResolvedValueOnce({
      path: "sessions/empty.jsonl",
      absPath: "/tmp/sessions/empty.jsonl",
      mtimeMs: Date.now(),
      size: 0,
      hash: "empty-hash",
      content: "",
      lineMap: [],
    });

    const result = await syncToMongoDB({
      db: {} as Db,
      prefix: "test_",
      workspaceDir: tmpDir,
      agentId: "agent-1",
      embeddingMode: "automated",
    });

    // null entry skipped, empty content entry skipped
    expect(result.sessionFilesProcessed).toBe(0);
  });

  it("session paths are tracked for stale cleanup", async () => {
    const sessionEntry = {
      path: "sessions/tracked.jsonl",
      absPath: "/tmp/sessions/tracked.jsonl",
      mtimeMs: Date.now(),
      size: 100,
      hash: "tracked-hash",
      content: "User: Track me\nAssistant: Tracked",
      lineMap: [1, 2],
    };

    vi.mocked(listSessionFilesForAgent).mockResolvedValue(["/tmp/sessions/tracked.jsonl"]);
    vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry);

    // Mock stale chunk detection — sessions/old.jsonl is stale
    (mockChunks.distinct as ReturnType<typeof vi.fn>).mockResolvedValue([
      "sessions/tracked.jsonl",
      "sessions/old.jsonl",
    ]);
    (mockChunks.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ deletedCount: 2 });

    const result = await syncToMongoDB({
      db: {} as Db,
      prefix: "test_",
      workspaceDir: tmpDir,
      agentId: "agent-1",
      embeddingMode: "automated",
    });

    // sessions/old.jsonl should be deleted as stale
    expect(result.staleDeleted).toBe(2);
    expect(mockChunks.deleteMany).toHaveBeenCalledWith({
      path: { $in: ["sessions/old.jsonl"] },
    });
  });

  it("generates embeddings for session files in managed mode", async () => {
    const sessionEntry = {
      path: "sessions/embed-test.jsonl",
      absPath: "/tmp/sessions/embed-test.jsonl",
      mtimeMs: Date.now(),
      size: 200,
      hash: "embed-session-hash",
      content: "User: Embed me\nAssistant: Embedded",
      lineMap: [1, 2],
    };

    vi.mocked(listSessionFilesForAgent).mockResolvedValue(["/tmp/sessions/embed-test.jsonl"]);
    vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry);

    const mockProvider = {
      id: "mock",
      model: "mock-model",
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.5, 0.6, 0.7])),
      embedQuery: vi.fn(async () => [0.5, 0.6, 0.7]),
    };

    await syncToMongoDB({
      db: {} as Db,
      prefix: "test_",
      workspaceDir: tmpDir,
      agentId: "agent-1",
      embeddingMode: "managed",
      embeddingProvider: mockProvider,
      model: "mock-model",
    });

    expect(mockProvider.embedBatch).toHaveBeenCalled();
    const bulkOps = (mockChunks.bulkWrite as ReturnType<typeof vi.fn>).mock.calls[0][0];
    for (const op of bulkOps) {
      expect(op.updateOne.update.$set.embedding).toEqual([0.5, 0.6, 0.7]);
      expect(op.updateOne.update.$set.source).toBe("sessions");
    }
  });
});
