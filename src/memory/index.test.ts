import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

let embedBatchCalls = 0;

// Unit tests: avoid importing the real chokidar implementation (native fsevents, etc.).
vi.mock("chokidar", () => ({
  default: {
    watch: () => ({ on: () => {}, close: async () => {} }),
  },
  watch: () => ({ on: () => {}, close: async () => {} }),
}));

vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ ok: false, error: "sqlite-vec disabled in tests" }),
}));

vi.mock("./embeddings.js", () => {
  const embedText = (text: string) => {
    const lower = text.toLowerCase();
    const alpha = lower.split("alpha").length - 1;
    const beta = lower.split("beta").length - 1;
    return [alpha, beta];
  };
  return {
    createEmbeddingProvider: async (options: { model?: string }) => ({
      requestedProvider: "openai",
      provider: {
        id: "mock",
        model: options.model ?? "mock-embed",
        embedQuery: async (text: string) => embedText(text),
        embedBatch: async (texts: string[]) => {
          embedBatchCalls += 1;
          return texts.map(embedText);
        },
      },
    }),
  };
});

describe("memory index", () => {
  let fixtureRoot = "";
  let workspaceDir = "";
  let memoryDir = "";
  let extraDir = "";
  let indexBasicPath = "";
  let indexCachePath = "";
  let indexHybridPath = "";
  let indexVectorPath = "";
  let indexExtraPath = "";

  const persistentManagers = new Set<MemoryIndexManager>();

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-fixtures-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    memoryDir = path.join(workspaceDir, "memory");
    extraDir = path.join(workspaceDir, "extra");
    indexBasicPath = path.join(workspaceDir, "index-basic.sqlite");
    indexCachePath = path.join(workspaceDir, "index-cache.sqlite");
    indexHybridPath = path.join(workspaceDir, "index-hybrid.sqlite");
    indexVectorPath = path.join(workspaceDir, "index-vector.sqlite");
    indexExtraPath = path.join(workspaceDir, "index-extra.sqlite");

    await fs.mkdir(memoryDir, { recursive: true });
  });

  afterAll(async () => {
    await Promise.all(Array.from(persistentManagers).map((manager) => manager.close()));
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Perf: most suites don't need atomic swap behavior for full reindexes.
    // Keep atomic reindex tests on the safe path.
    vi.stubEnv("OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX", "1");
    embedBatchCalls = 0;

    // Keep the workspace stable to allow manager reuse across tests.
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, "2026-01-12.md"),
      "# Log\nAlpha memory line.\nZebra memory line.",
    );

    // Clean additional paths that may have been created by earlier cases.
    await fs.rm(extraDir, { recursive: true, force: true });

    for (const manager of persistentManagers) {
      resetManagerForTest(manager);
    }
  });

  function resetManagerForTest(manager: MemoryIndexManager) {
    // These tests reuse managers for performance. Clear the index + embedding
    // cache to keep each test fully isolated.
    (manager as unknown as { resetIndex: () => void }).resetIndex();
    (manager as unknown as { db: { exec: (sql: string) => void } }).db.exec(
      "DELETE FROM embedding_cache",
    );
    (manager as unknown as { dirty: boolean }).dirty = true;
    (manager as unknown as { sessionsDirty: boolean }).sessionsDirty = false;
  }

  type TestCfg = Parameters<typeof getMemorySearchManager>[0]["cfg"];

  async function getPersistentManager(cfg: TestCfg): Promise<MemoryIndexManager> {
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    const manager = result.manager as MemoryIndexManager;
    persistentManagers.add(manager);
    return manager;
  }

  it("indexes memory files and searches by vector", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexBasicPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: true },
            query: { minScore: 0, hybrid: { enabled: false } },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });
    const results = await manager.search("alpha");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.path).toContain("memory/2026-01-12.md");
    const status = manager.status();
    expect(status.sourceCounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "memory",
          files: status.files,
          chunks: status.chunks,
        }),
      ]),
    );
  });

  it("reindexes when the embedding model changes", async () => {
    const indexModelPath = path.join(workspaceDir, "index-model-change.sqlite");
    await fs.rm(indexModelPath, { force: true });
    await fs.rm(`${indexModelPath}-shm`, { force: true });
    await fs.rm(`${indexModelPath}-wal`, { force: true });

    const base = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            store: { path: indexModelPath },
            sync: { watch: false, onSessionStart: false, onSearch: true },
            query: { minScore: 0, hybrid: { enabled: false } },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };

    const first = await getMemorySearchManager({
      cfg: {
        ...base,
        agents: {
          ...base.agents,
          defaults: {
            ...base.agents.defaults,
            memorySearch: {
              ...base.agents.defaults.memorySearch,
              model: "mock-embed-v1",
            },
          },
        },
      },
      agentId: "main",
    });
    expect(first.manager).not.toBeNull();
    if (!first.manager) {
      throw new Error("manager missing");
    }
    await first.manager.sync({ reason: "test" });
    const callsAfterFirstSync = embedBatchCalls;
    await first.manager.close();

    const second = await getMemorySearchManager({
      cfg: {
        ...base,
        agents: {
          ...base.agents,
          defaults: {
            ...base.agents.defaults,
            memorySearch: {
              ...base.agents.defaults.memorySearch,
              model: "mock-embed-v2",
            },
          },
        },
      },
      agentId: "main",
    });
    expect(second.manager).not.toBeNull();
    if (!second.manager) {
      throw new Error("manager missing");
    }
    await second.manager.sync({ reason: "test" });
    expect(embedBatchCalls).toBeGreaterThan(callsAfterFirstSync);
    const status = second.manager.status();
    expect(status.files).toBeGreaterThan(0);
    await second.manager.close();
  });

  it("reuses cached embeddings on forced reindex", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexCachePath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0, hybrid: { enabled: false } },
            cache: { enabled: true },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const manager = await getPersistentManager(cfg);
    await manager.sync({ force: true });
    const afterFirst = embedBatchCalls;
    expect(afterFirst).toBeGreaterThan(0);

    await manager.sync({ force: true });
    expect(embedBatchCalls).toBe(afterFirst);
  });

  it("finds keyword matches via hybrid search when query embedding is zero", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexHybridPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: true },
            query: {
              minScore: 0,
              hybrid: { enabled: true, vectorWeight: 0, textWeight: 1 },
            },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const manager = await getPersistentManager(cfg);

    const status = manager.status();
    if (!status.fts?.available) {
      return;
    }

    await manager.sync({ reason: "test" });
    const results = await manager.search("zebra");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.path).toContain("memory/2026-01-12.md");
  });

  it("reports vector availability after probe", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexVectorPath, vector: { enabled: true } },
            sync: { watch: false, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const manager = await getPersistentManager(cfg);
    const available = await manager.probeVectorAvailability();
    const status = manager.status();
    expect(status.vector?.enabled).toBe(true);
    expect(typeof status.vector?.available).toBe("boolean");
    expect(status.vector?.available).toBe(available);
  });

  it("rejects reading non-memory paths", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexBasicPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: true },
            query: { minScore: 0, hybrid: { enabled: false } },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const manager = await getPersistentManager(cfg);
    await expect(manager.readFile({ relPath: "NOTES.md" })).rejects.toThrow("path required");
  });

  it("allows reading from additional memory paths and blocks symlinks", async () => {
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "extra.md"), "Extra content.");

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexExtraPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: true },
            query: { minScore: 0, hybrid: { enabled: false } },
            extraPaths: [extraDir],
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const manager = await getPersistentManager(cfg);
    await expect(manager.readFile({ relPath: "extra/extra.md" })).resolves.toEqual({
      path: "extra/extra.md",
      text: "Extra content.",
    });

    const linkPath = path.join(extraDir, "linked.md");
    let symlinkOk = true;
    try {
      await fs.symlink(path.join(extraDir, "extra.md"), linkPath, "file");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        symlinkOk = false;
      } else {
        throw err;
      }
    }
    if (symlinkOk) {
      await expect(manager.readFile({ relPath: "extra/linked.md" })).rejects.toThrow(
        "path required",
      );
    }
  });
});
