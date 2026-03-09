import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { MemoryIndexManager, getMemorySearchManager } from "./index.js";

const closeMock = vi.fn(async () => undefined);

vi.mock("chokidar", () => ({
  default: {
    watch: vi.fn(() => ({
      on: vi.fn(),
      close: closeMock,
    })),
  },
}));

vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ ok: false, error: "sqlite-vec disabled in tests" }),
}));

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "mock",
      model: "mock-embed",
      embedQuery: async () => [1, 0],
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0]),
    },
  }),
}));

function makeConfig(workspaceDir: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          provider: "openai",
          model: "mock-embed",
          store: { path: path.join(workspaceDir, "index.sqlite"), vector: { enabled: false } },
          sync: { watch: true, watchDebounceMs: 25, onSessionStart: false, onSearch: false },
          query: { minScore: 0, hybrid: { enabled: false } },
        },
      },
      list: [{ id: "main", default: true }],
    },
  } as OpenClawConfig;
}

describe("MemoryIndexManager.closeAll()", () => {
  const workspaceDirs: string[] = [];

  afterEach(async () => {
    // Ensure cache is cleared between tests
    await MemoryIndexManager.closeAll();
    closeMock.mockClear();
    for (const dir of workspaceDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("closes all cached managers and clears the cache", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-closeall-"));
    workspaceDirs.push(workspaceDir);
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# test");

    const cfg = makeConfig(workspaceDir);

    // Acquire a manager — this populates INDEX_CACHE and starts the watcher
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();

    // closeAll should close the watcher
    await MemoryIndexManager.closeAll();

    expect(closeMock).toHaveBeenCalledTimes(1);

    // Second closeAll should be a no-op (cache already empty)
    await MemoryIndexManager.closeAll();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — calling closeAll twice does not throw", async () => {
    await expect(MemoryIndexManager.closeAll()).resolves.not.toThrow();
    await expect(MemoryIndexManager.closeAll()).resolves.not.toThrow();
  });
});
