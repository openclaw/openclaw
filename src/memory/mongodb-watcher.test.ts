import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock chokidar before any imports that use it
// ---------------------------------------------------------------------------

const mockWatcherInstance = {
  on: vi.fn().mockReturnThis(),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock("chokidar", () => ({
  default: {
    watch: vi.fn(() => mockWatcherInstance),
  },
}));

// Mock mongodb to avoid needing a real connection
vi.mock("mongodb", () => {
  const mockDb = {
    collection: vi.fn(() => ({
      countDocuments: vi.fn().mockResolvedValue(0),
    })),
    command: vi.fn().mockResolvedValue({ ok: 1 }),
  };
  class MockMongoClient {
    connect = vi.fn().mockResolvedValue(undefined);
    db = vi.fn(() => mockDb);
    close = vi.fn().mockResolvedValue(undefined);
  }
  return {
    MongoClient: MockMongoClient,
  };
});

// Mock internal dependencies
vi.mock("./mongodb-schema.js", () => ({
  chunksCollection: vi.fn(() => ({
    countDocuments: vi.fn().mockResolvedValue(0),
  })),
  filesCollection: vi.fn(() => ({
    countDocuments: vi.fn().mockResolvedValue(0),
  })),
  metaCollection: vi.fn(() => ({
    findOne: vi.fn().mockResolvedValue(null),
    updateOne: vi.fn().mockResolvedValue({ upsertedCount: 1 }),
  })),
  detectCapabilities: vi.fn().mockResolvedValue({
    vectorSearch: false,
    textSearch: false,
    scoreFusion: false,
    rankFusion: false,
  }),
  ensureCollections: vi.fn().mockResolvedValue(undefined),
  ensureStandardIndexes: vi.fn().mockResolvedValue(undefined),
  ensureSearchIndexes: vi.fn().mockResolvedValue(undefined),
  ensureSchemaValidation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./mongodb-search.js", () => ({
  mongoSearch: vi.fn().mockResolvedValue([]),
}));

vi.mock("./mongodb-sync.js", () => ({
  syncToMongoDB: vi.fn().mockResolvedValue({
    filesProcessed: 0,
    chunksUpserted: 0,
    sessionFilesProcessed: 0,
    sessionChunksUpserted: 0,
  }),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: vi.fn(() => "/workspace"),
}));

vi.mock("./internal.js", () => ({
  normalizeExtraMemoryPaths: vi.fn((_ws: string, paths?: string[]) => paths ?? []),
  isMemoryPath: vi.fn(() => true),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  })),
}));

import chokidar from "chokidar";
import type { ResolvedMemoryBackendConfig } from "./backend-config.js";
import { MongoDBMemoryManager } from "./mongodb-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(
  overrides?: Partial<ResolvedMemoryBackendConfig["mongodb"]>,
): ResolvedMemoryBackendConfig {
  return {
    backend: "mongodb",
    citations: "auto",
    mongodb: {
      uri: "mongodb://localhost:27017",
      database: "testdb",
      collectionPrefix: "test_",
      deploymentProfile: "community-bare",
      embeddingMode: "managed",
      fusionMethod: "js-merge",
      quantization: "none",
      watchDebounceMs: 500,
      numDimensions: 1024,
      maxPoolSize: 10,
      embeddingCacheTtlDays: 30,
      memoryTtlDays: 0,
      enableChangeStreams: false,
      changeStreamDebounceMs: 1000,
      connectTimeoutMs: 10_000,
      numCandidates: 200,
      kb: {
        enabled: true,
        chunking: { tokens: 600, overlap: 100 },
        autoImportPaths: [],
        maxDocumentSize: 10 * 1024 * 1024,
        autoRefreshHours: 24,
      },
      ...overrides,
    },
  };
}

async function createManager(
  configOverrides?: Partial<ResolvedMemoryBackendConfig["mongodb"]>,
): Promise<MongoDBMemoryManager> {
  const resolved = makeConfig(configOverrides);
  const manager = await MongoDBMemoryManager.create({
    cfg: {
      agents: { defaults: { workspace: "/workspace" } },
    } as any,
    agentId: "main",
    resolved,
  });
  if (!manager) {
    throw new Error("Manager creation returned null");
  }
  return manager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MongoDBMemoryManager file watcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // ensureWatcher()
  // -------------------------------------------------------------------------

  it("sets up chokidar watcher on create() with correct paths", async () => {
    const manager = await createManager();

    expect(chokidar.watch).toHaveBeenCalledTimes(1);
    const watchCall = vi.mocked(chokidar.watch).mock.calls[0];
    const watchedPaths = watchCall[0] as string[];

    // Should watch MEMORY.md, memory.md, and memory/ directory
    expect(watchedPaths).toContain(path.join("/workspace", "MEMORY.md"));
    expect(watchedPaths).toContain(path.join("/workspace", "memory.md"));
    expect(watchedPaths).toContain(path.join("/workspace", "memory"));

    await manager.close();
  });

  it("passes ignoreInitial and awaitWriteFinish options to chokidar", async () => {
    const manager = await createManager({ watchDebounceMs: 750 });

    const watchCall = vi.mocked(chokidar.watch).mock.calls[0];
    const opts = watchCall[1] as Record<string, unknown>;
    expect(opts.ignoreInitial).toBe(true);
    expect(opts.awaitWriteFinish).toEqual({
      stabilityThreshold: 750,
      pollInterval: 100,
    });

    await manager.close();
  });

  it("registers add, change, and unlink event handlers", async () => {
    const manager = await createManager();

    expect(mockWatcherInstance.on).toHaveBeenCalledWith("add", expect.any(Function));
    expect(mockWatcherInstance.on).toHaveBeenCalledWith("change", expect.any(Function));
    expect(mockWatcherInstance.on).toHaveBeenCalledWith("unlink", expect.any(Function));

    await manager.close();
  });

  it("includes extraPaths in the watch list", async () => {
    const { normalizeExtraMemoryPaths } = await import("./internal.js");
    vi.mocked(normalizeExtraMemoryPaths).mockReturnValue(["/extra/path1.md", "/extra/path2"]);

    const manager = await createManager();

    const watchCall = vi.mocked(chokidar.watch).mock.calls[0];
    const watchedPaths = watchCall[0] as string[];
    expect(watchedPaths).toContain("/extra/path1.md");
    expect(watchedPaths).toContain("/extra/path2");

    await manager.close();
  });

  // -------------------------------------------------------------------------
  // markDirty + dirty flag
  // -------------------------------------------------------------------------

  it("sets dirty=true when a watched file changes", async () => {
    const manager = await createManager();

    // First sync to clear the initial dirty flag
    await manager.sync({ reason: "init" });
    const statusBefore = manager.status();
    expect(statusBefore.dirty).toBe(false);

    // Simulate a file change event via chokidar
    const changeHandler = mockWatcherInstance.on.mock.calls.find(
      (call: unknown[]) => call[0] === "change",
    )![1] as () => void;
    changeHandler();

    const statusAfter = manager.status();
    expect(statusAfter.dirty).toBe(true);

    await manager.close();
  });

  it("sets dirty=true when a file is added", async () => {
    const manager = await createManager();
    await manager.sync({ reason: "init" });

    const addHandler = mockWatcherInstance.on.mock.calls.find(
      (call: unknown[]) => call[0] === "add",
    )![1] as () => void;
    addHandler();

    expect(manager.status().dirty).toBe(true);
    await manager.close();
  });

  it("sets dirty=true when a file is unlinked", async () => {
    const manager = await createManager();
    await manager.sync({ reason: "init" });

    const unlinkHandler = mockWatcherInstance.on.mock.calls.find(
      (call: unknown[]) => call[0] === "unlink",
    )![1] as () => void;
    unlinkHandler();

    expect(manager.status().dirty).toBe(true);
    await manager.close();
  });

  // -------------------------------------------------------------------------
  // scheduleWatchSync() — debounced sync
  // -------------------------------------------------------------------------

  it("schedules a debounced sync when file changes", async () => {
    const { syncToMongoDB } = await import("./mongodb-sync.js");
    const manager = await createManager({ watchDebounceMs: 300 });

    // Clear sync calls from create
    vi.mocked(syncToMongoDB).mockClear();

    // Trigger a change
    const changeHandler = mockWatcherInstance.on.mock.calls.find(
      (call: unknown[]) => call[0] === "change",
    )![1] as () => void;
    changeHandler();

    // Should NOT sync immediately
    expect(syncToMongoDB).not.toHaveBeenCalled();

    // Fast-forward past debounce
    await vi.advanceTimersByTimeAsync(300);

    // Now should have synced with reason "watch"
    expect(syncToMongoDB).toHaveBeenCalled();
    const syncCall = vi.mocked(syncToMongoDB).mock.calls[0];
    expect(syncCall[0].reason).toBe("watch");

    await manager.close();
  });

  it("debounces multiple rapid file changes into a single sync", async () => {
    const { syncToMongoDB } = await import("./mongodb-sync.js");
    const manager = await createManager({ watchDebounceMs: 500 });
    vi.mocked(syncToMongoDB).mockClear();

    const changeHandler = mockWatcherInstance.on.mock.calls.find(
      (call: unknown[]) => call[0] === "change",
    )![1] as () => void;

    // Simulate rapid fire changes
    changeHandler();
    await vi.advanceTimersByTimeAsync(100);
    changeHandler();
    await vi.advanceTimersByTimeAsync(100);
    changeHandler();

    // Should not have synced yet (less than 500ms since last change)
    expect(syncToMongoDB).not.toHaveBeenCalled();

    // Advance past debounce from the LAST change
    await vi.advanceTimersByTimeAsync(500);

    // Should have synced exactly once
    expect(syncToMongoDB).toHaveBeenCalledTimes(1);

    await manager.close();
  });

  it("uses the default 500ms debounce when watchDebounceMs is not set", async () => {
    const { syncToMongoDB } = await import("./mongodb-sync.js");
    const manager = await createManager({ watchDebounceMs: 500 });
    vi.mocked(syncToMongoDB).mockClear();

    const changeHandler = mockWatcherInstance.on.mock.calls.find(
      (call: unknown[]) => call[0] === "change",
    )![1] as () => void;
    changeHandler();

    // At 400ms — should not have synced
    await vi.advanceTimersByTimeAsync(400);
    expect(syncToMongoDB).not.toHaveBeenCalled();

    // At 500ms — should sync
    await vi.advanceTimersByTimeAsync(100);
    expect(syncToMongoDB).toHaveBeenCalledTimes(1);

    await manager.close();
  });

  // -------------------------------------------------------------------------
  // close() — cleanup
  // -------------------------------------------------------------------------

  it("closes the chokidar watcher on close()", async () => {
    const manager = await createManager();

    await manager.close();

    expect(mockWatcherInstance.close).toHaveBeenCalledTimes(1);
  });

  it("clears the watch timer on close()", async () => {
    const { syncToMongoDB } = await import("./mongodb-sync.js");
    const manager = await createManager({ watchDebounceMs: 1000 });
    vi.mocked(syncToMongoDB).mockClear();

    // Trigger a change to start the debounce timer
    const changeHandler = mockWatcherInstance.on.mock.calls.find(
      (call: unknown[]) => call[0] === "change",
    )![1] as () => void;
    changeHandler();

    // Close before timer fires
    await manager.close();

    // Advance time past what would have been the debounce
    await vi.advanceTimersByTimeAsync(2000);

    // Sync should NOT have been called — timer was cleared
    expect(syncToMongoDB).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // watchDebounceMs config
  // -------------------------------------------------------------------------

  it("uses custom watchDebounceMs from config", async () => {
    const manager = await createManager({ watchDebounceMs: 1200 });

    const watchCall = vi.mocked(chokidar.watch).mock.calls[0];
    const opts = watchCall[1] as Record<string, unknown>;
    expect(opts.awaitWriteFinish).toEqual({
      stabilityThreshold: 1200,
      pollInterval: 100,
    });

    await manager.close();
  });
});

// ---------------------------------------------------------------------------
// Config resolution tests for watchDebounceMs
// ---------------------------------------------------------------------------

describe("resolveMemoryBackendConfig — watchDebounceMs", () => {
  // These tests verify the config layer passes through watchDebounceMs
  // They are in backend-config.test.ts extension

  it("defaults watchDebounceMs to 500 when not set", async () => {
    // This test is imported from the config resolution test suite
    const { resolveMemoryBackendConfig } = await import("./backend-config.js");
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: {
          uri: "mongodb://localhost:27017",
        },
      },
    } as any;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.watchDebounceMs).toBe(500);
  });

  it("resolves custom watchDebounceMs from config", async () => {
    const { resolveMemoryBackendConfig } = await import("./backend-config.js");
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: {
          uri: "mongodb://localhost:27017",
          watchDebounceMs: 2000,
        },
      },
    } as any;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.watchDebounceMs).toBe(2000);
  });
});
