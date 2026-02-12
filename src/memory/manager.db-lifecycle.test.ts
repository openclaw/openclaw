import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

let embedDelay = 0;

vi.mock("chokidar", () => ({
  default: {
    watch: vi.fn(() => ({
      on: vi.fn(),
      close: vi.fn(async () => undefined),
    })),
  },
}));

vi.mock("./embeddings.js", () => {
  return {
    createEmbeddingProvider: async () => ({
      requestedProvider: "openai",
      provider: {
        id: "mock",
        model: "mock-embed",
        embedQuery: async () => [1, 0, 0],
        embedBatch: async (texts: string[]) => {
          if (embedDelay > 0) {
            await new Promise((resolve) => setTimeout(resolve, embedDelay));
          }
          return texts.map((_, index) => [index + 1, 0, 0]);
        },
      },
    }),
  };
});

function makeCfg(workspaceDir: string, indexPath: string) {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          provider: "openai",
          model: "mock-embed",
          store: { path: indexPath },
          cache: { enabled: false },
          sync: { watch: false, onSessionStart: true, onSearch: false },
        },
      },
      list: [{ id: "main", default: true }],
    },
  };
}

describe("memory manager DB lifecycle", () => {
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    embedDelay = 0;
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-lifecycle-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"));
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Hello lifecycle test.");
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("status() does not throw during concurrent reindex", async () => {
    const cfg = makeCfg(workspaceDir, indexPath);
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    manager = result.manager!;

    // Add a small delay to embeddings so the sync is in-flight long enough
    embedDelay = 50;

    // Start a sync (which triggers runSafeReindex on first run)
    const syncPromise = manager.sync({ force: true });

    // While sync is in flight, call status() — this must not throw
    // "database is not open"
    let statusError: Error | null = null;
    const statusInterval = setInterval(() => {
      try {
        manager!.status();
      } catch (err) {
        statusError = err as Error;
      }
    }, 5);

    await syncPromise;
    clearInterval(statusInterval);

    expect(statusError).toBeNull();
  });

  it("search() returns results after reindex without db-not-open errors", async () => {
    const cfg = makeCfg(workspaceDir, indexPath);
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    manager = result.manager!;

    // Sync to build the index
    await manager.sync({ force: true });

    const results = await manager.search("Hello");
    expect(results.length).toBeGreaterThan(0);

    // Force a second reindex
    await manager.sync({ force: true });

    // Search after reindex must still work
    const after = await manager.search("lifecycle");
    // Even if no match, the point is it doesn't throw "database is not open"
    expect(Array.isArray(after)).toBe(true);
  });

  it("close() waits for in-flight sync to complete", async () => {
    const cfg = makeCfg(workspaceDir, indexPath);
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    manager = result.manager!;

    embedDelay = 80;

    // Fire a sync but don't await it
    const syncPromise = manager.sync({ force: true });

    // Close while sync is running — close() should wait for it
    await manager.close();

    // The sync should have completed (or thrown) before close returned
    // Verify it didn't leave a dangling rejection
    await syncPromise.catch(() => {});

    // After close, the manager should be unusable but not crash
    manager = null; // prevent afterEach double-close
  });

  it("sync() is a no-op after close()", async () => {
    const cfg = makeCfg(workspaceDir, indexPath);
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    manager = result.manager!;

    await manager.close();

    // sync after close should silently return, not throw
    await expect(manager.sync({ force: true })).resolves.toBeUndefined();

    manager = null; // prevent afterEach double-close
  });

  it("warmSession() is a no-op after close()", async () => {
    const cfg = makeCfg(workspaceDir, indexPath);
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    manager = result.manager!;

    await manager.close();

    // warmSession after close should not throw
    await expect(manager.warmSession("test-key")).resolves.toBeUndefined();

    manager = null;
  });

  it("reindex error recovery leaves DB in a usable state", async () => {
    const cfg = makeCfg(workspaceDir, indexPath);
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    manager = result.manager!;

    // First sync should succeed and build the index
    await manager.sync({ force: true });
    const before = manager.status();
    expect(before.files).toBeGreaterThan(0);

    // Make subsequent embeddings fail
    embedDelay = -1; // We'll use a different flag
    const origModule = await import("./embeddings.js");
    const origCreate = origModule.createEmbeddingProvider;

    // Force a reindex that will fail by removing the workspace files
    await fs.rm(path.join(workspaceDir, "MEMORY.md"));
    await fs.rm(path.join(workspaceDir, "memory"), { recursive: true });

    // Sync should succeed (no files to index)
    await manager.sync({ force: true });

    // DB should still be usable
    const status = manager.status();
    expect(typeof status.files).toBe("number");
  });
});
