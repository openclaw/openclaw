import { describe, expect, it, vi } from "vitest";
import { runExtensionHostEmbeddingSync } from "./embedding-sync-execution.js";

describe("embedding-sync-execution", () => {
  it("prefers targeted session refreshes and clears only the targeted dirty files", async () => {
    const syncSessionFiles = vi.fn(async () => {});
    const clearSyncedSessionFiles = vi.fn();

    await runExtensionHostEmbeddingSync({
      reason: "post-compaction",
      targetSessionFiles: new Set(["/tmp/a.jsonl"]),
      vectorReady: false,
      meta: null,
      configuredSources: ["sessions"],
      configuredScopeHash: "scope",
      provider: null,
      providerKey: null,
      chunkTokens: 200,
      chunkOverlap: 20,
      sessionsEnabled: true,
      dirty: true,
      shouldSyncSessions: true,
      useUnsafeReindex: false,
      hasDirtySessionFiles: true,
      syncMemoryFiles: vi.fn(async () => {}),
      syncSessionFiles,
      clearSyncedSessionFiles,
      clearAllSessionDirtyFiles: vi.fn(),
      setDirty: vi.fn(),
      setSessionsDirty: vi.fn(),
      shouldFallbackOnError: vi.fn(() => false),
      activateFallbackProvider: vi.fn(async () => false),
      runSafeReindex: vi.fn(async () => {}),
      runUnsafeReindex: vi.fn(async () => {}),
    });

    expect(syncSessionFiles).toHaveBeenCalledWith({
      needsFullReindex: false,
      targetSessionFiles: ["/tmp/a.jsonl"],
      progress: undefined,
    });
    expect(clearSyncedSessionFiles).toHaveBeenCalledWith(new Set(["/tmp/a.jsonl"]));
  });

  it("runs an unsafe reindex when fallback activates during a targeted refresh", async () => {
    const runUnsafeReindex = vi.fn(async () => {});

    await runExtensionHostEmbeddingSync({
      reason: "post-compaction",
      targetSessionFiles: new Set(["/tmp/a.jsonl"]),
      vectorReady: false,
      meta: null,
      configuredSources: ["sessions"],
      configuredScopeHash: "scope",
      provider: null,
      providerKey: null,
      chunkTokens: 200,
      chunkOverlap: 20,
      sessionsEnabled: true,
      dirty: false,
      shouldSyncSessions: true,
      useUnsafeReindex: true,
      hasDirtySessionFiles: false,
      syncMemoryFiles: vi.fn(async () => {}),
      syncSessionFiles: vi.fn(async () => {
        throw new Error("embedding backend failed");
      }),
      clearSyncedSessionFiles: vi.fn(),
      clearAllSessionDirtyFiles: vi.fn(),
      setDirty: vi.fn(),
      setSessionsDirty: vi.fn(),
      shouldFallbackOnError: vi.fn(() => true),
      activateFallbackProvider: vi.fn(async () => true),
      runSafeReindex: vi.fn(async () => {}),
      runUnsafeReindex,
    });

    expect(runUnsafeReindex).toHaveBeenCalledWith({
      reason: "post-compaction",
      force: true,
      progress: undefined,
    });
  });

  it("runs a full safe reindex when planning detects metadata drift", async () => {
    const runSafeReindex = vi.fn(async () => {});

    await runExtensionHostEmbeddingSync({
      reason: "test",
      force: false,
      targetSessionFiles: null,
      vectorReady: true,
      meta: {
        model: "old-model",
        provider: "openai",
        providerKey: "key",
        sources: ["memory"],
        scopeHash: "scope",
        chunkTokens: 200,
        chunkOverlap: 20,
      },
      configuredSources: ["memory"],
      configuredScopeHash: "scope",
      provider: {
        id: "openai",
        model: "new-model",
        embedQuery: async () => [1],
        embedBatch: async () => [[1]],
      },
      providerKey: "key",
      chunkTokens: 200,
      chunkOverlap: 20,
      sessionsEnabled: false,
      dirty: false,
      shouldSyncSessions: false,
      useUnsafeReindex: false,
      hasDirtySessionFiles: false,
      syncMemoryFiles: vi.fn(async () => {}),
      syncSessionFiles: vi.fn(async () => {}),
      clearSyncedSessionFiles: vi.fn(),
      clearAllSessionDirtyFiles: vi.fn(),
      setDirty: vi.fn(),
      setSessionsDirty: vi.fn(),
      shouldFallbackOnError: vi.fn(() => false),
      activateFallbackProvider: vi.fn(async () => false),
      runSafeReindex,
      runUnsafeReindex: vi.fn(async () => {}),
    });

    expect(runSafeReindex).toHaveBeenCalledWith({
      reason: "test",
      force: false,
      progress: undefined,
    });
  });

  it("clears dirty flags after incremental syncs and preserves pending session dirtiness otherwise", async () => {
    const setDirty = vi.fn();
    const setSessionsDirty = vi.fn();
    const clearAllSessionDirtyFiles = vi.fn();

    await runExtensionHostEmbeddingSync({
      reason: "watch",
      targetSessionFiles: null,
      vectorReady: true,
      meta: {
        model: "model",
        provider: "openai",
        providerKey: "key",
        sources: ["memory", "sessions"],
        scopeHash: "scope",
        chunkTokens: 200,
        chunkOverlap: 20,
        vectorDims: 1536,
      },
      configuredSources: ["memory", "sessions"],
      configuredScopeHash: "scope",
      provider: {
        id: "openai",
        model: "model",
        embedQuery: async () => [1],
        embedBatch: async () => [[1]],
      },
      providerKey: "key",
      chunkTokens: 200,
      chunkOverlap: 20,
      sessionsEnabled: true,
      dirty: true,
      shouldSyncSessions: true,
      useUnsafeReindex: false,
      hasDirtySessionFiles: true,
      syncMemoryFiles: vi.fn(async () => {}),
      syncSessionFiles: vi.fn(async () => {}),
      clearSyncedSessionFiles: vi.fn(),
      clearAllSessionDirtyFiles,
      setDirty,
      setSessionsDirty,
      shouldFallbackOnError: vi.fn(() => false),
      activateFallbackProvider: vi.fn(async () => false),
      runSafeReindex: vi.fn(async () => {}),
      runUnsafeReindex: vi.fn(async () => {}),
    });

    expect(setDirty).toHaveBeenCalledWith(false);
    expect(setSessionsDirty).toHaveBeenCalledWith(false);
    expect(clearAllSessionDirtyFiles).toHaveBeenCalled();

    setSessionsDirty.mockClear();

    await runExtensionHostEmbeddingSync({
      reason: "watch",
      targetSessionFiles: null,
      vectorReady: true,
      meta: {
        model: "model",
        provider: "openai",
        providerKey: "key",
        sources: ["memory", "sessions"],
        scopeHash: "scope",
        chunkTokens: 200,
        chunkOverlap: 20,
        vectorDims: 1536,
      },
      configuredSources: ["memory", "sessions"],
      configuredScopeHash: "scope",
      provider: {
        id: "openai",
        model: "model",
        embedQuery: async () => [1],
        embedBatch: async () => [[1]],
      },
      providerKey: "key",
      chunkTokens: 200,
      chunkOverlap: 20,
      sessionsEnabled: true,
      dirty: false,
      shouldSyncSessions: false,
      useUnsafeReindex: false,
      hasDirtySessionFiles: true,
      syncMemoryFiles: vi.fn(async () => {}),
      syncSessionFiles: vi.fn(async () => {}),
      clearSyncedSessionFiles: vi.fn(),
      clearAllSessionDirtyFiles: vi.fn(),
      setDirty: vi.fn(),
      setSessionsDirty,
      shouldFallbackOnError: vi.fn(() => false),
      activateFallbackProvider: vi.fn(async () => false),
      runSafeReindex: vi.fn(async () => {}),
      runUnsafeReindex: vi.fn(async () => {}),
    });

    expect(setSessionsDirty).toHaveBeenCalledWith(true);
  });
});
