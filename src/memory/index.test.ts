import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";
import "./test-runtime-mocks.js";

let embedBatchCalls = 0;

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
  let indexVectorPath = "";
  let indexMainPath = "";
  let indexExtraPath = "";

  // Perf: keep managers open across tests, but only reset the one a test uses.
  const managersByStorePath = new Map<string, MemoryIndexManager>();
  const managersForCleanup = new Set<MemoryIndexManager>();

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-fixtures-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    memoryDir = path.join(workspaceDir, "memory");
    extraDir = path.join(workspaceDir, "extra");
    indexMainPath = path.join(workspaceDir, "index-main.sqlite");
    indexVectorPath = path.join(workspaceDir, "index-vector.sqlite");
    indexExtraPath = path.join(workspaceDir, "index-extra.sqlite");

    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, "2026-01-12.md"),
      "# Log\nAlpha memory line.\nZebra memory line.",
    );
  });

  afterAll(async () => {
    await Promise.all(Array.from(managersForCleanup).map((manager) => manager.close()));
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Perf: most suites don't need atomic swap behavior for full reindexes.
    // Keep atomic reindex tests on the safe path.
    vi.stubEnv("OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX", "1");
    embedBatchCalls = 0;

    // Keep the workspace stable to allow manager reuse across tests.
    await fs.mkdir(memoryDir, { recursive: true });

    // Clean additional paths that may have been created by earlier cases.
    await fs.rm(extraDir, { recursive: true, force: true });
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

  function createCfg(params: {
    storePath: string;
    extraPaths?: string[];
    sources?: Array<"memory" | "sessions">;
    sessionMemory?: boolean;
    model?: string;
    vectorEnabled?: boolean;
    cacheEnabled?: boolean;
    hybrid?: { enabled: boolean; vectorWeight?: number; textWeight?: number };
  }): TestCfg {
    return {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: params.model ?? "mock-embed",
            store: { path: params.storePath, vector: { enabled: params.vectorEnabled ?? false } },
            // Perf: keep test indexes to a single chunk to reduce sqlite work.
            chunking: { tokens: 4000, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: true },
            query: {
              minScore: 0,
              hybrid: params.hybrid ?? { enabled: false },
            },
            cache: params.cacheEnabled ? { enabled: true } : undefined,
            extraPaths: params.extraPaths,
            sources: params.sources,
            experimental: { sessionMemory: params.sessionMemory ?? false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
  }

  async function getPersistentManager(cfg: TestCfg): Promise<MemoryIndexManager> {
    const storePath = cfg.agents?.defaults?.memorySearch?.store?.path;
    if (!storePath) {
      throw new Error("store path missing");
    }
    const cached = managersByStorePath.get(storePath);
    if (cached) {
      resetManagerForTest(cached);
      return cached;
    }

    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    const manager = result.manager as MemoryIndexManager;
    managersByStorePath.set(storePath, manager);
    managersForCleanup.add(manager);
    resetManagerForTest(manager);
    return manager;
  }

  it("indexes memory files and searches", async () => {
    const cfg = createCfg({
      storePath: indexMainPath,
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });
    expect(embedBatchCalls).toBeGreaterThan(0);
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

  it("keeps dirty false in status-only manager after prior indexing", async () => {
    const indexStatusPath = path.join(workspaceDir, `index-status-${Date.now()}.sqlite`);
    const cfg = createCfg({ storePath: indexStatusPath });

    const first = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(first.manager).not.toBeNull();
    if (!first.manager) {
      throw new Error("manager missing");
    }
    await first.manager.sync?.({ reason: "test" });
    await first.manager.close?.();

    const statusOnly = await getMemorySearchManager({
      cfg,
      agentId: "main",
      purpose: "status",
    });
    expect(statusOnly.manager).not.toBeNull();
    if (!statusOnly.manager) {
      throw new Error("status manager missing");
    }

    const status = statusOnly.manager.status();
    expect(status.dirty).toBe(false);
    await statusOnly.manager.close?.();
  });

  it("reindexes sessions when source config adds sessions to an existing index", async () => {
    const indexSourceChangePath = path.join(
      workspaceDir,
      `index-source-change-${Date.now()}.sqlite`,
    );
    const stateDir = path.join(fixtureRoot, `state-source-change-${Date.now()}`);
    const sessionDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "session-source-change.jsonl"),
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "session change test user line" }],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "session change test assistant line" }],
          },
        }),
      ].join("\n") + "\n",
    );

    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const firstCfg = createCfg({
      storePath: indexSourceChangePath,
      sources: ["memory"],
      sessionMemory: false,
    });
    const secondCfg = createCfg({
      storePath: indexSourceChangePath,
      sources: ["memory", "sessions"],
      sessionMemory: true,
    });

    try {
      const first = await getMemorySearchManager({ cfg: firstCfg, agentId: "main" });
      expect(first.manager).not.toBeNull();
      if (!first.manager) {
        throw new Error("manager missing");
      }
      await first.manager.sync?.({ reason: "test" });
      const firstStatus = first.manager.status();
      expect(
        firstStatus.sourceCounts?.find((entry) => entry.source === "sessions")?.files ?? 0,
      ).toBe(0);
      await first.manager.close?.();

      const second = await getMemorySearchManager({ cfg: secondCfg, agentId: "main" });
      expect(second.manager).not.toBeNull();
      if (!second.manager) {
        throw new Error("manager missing");
      }
      await second.manager.sync?.({ reason: "test" });
      const secondStatus = second.manager.status();
      expect(secondStatus.sourceCounts?.find((entry) => entry.source === "sessions")?.files).toBe(
        1,
      );
      expect(
        secondStatus.sourceCounts?.find((entry) => entry.source === "sessions")?.chunks ?? 0,
      ).toBeGreaterThan(0);
      await second.manager.close?.();
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("reindexes when the embedding model changes", async () => {
    const indexModelPath = path.join(workspaceDir, `index-model-change-${Date.now()}.sqlite`);
    const base = createCfg({ storePath: indexModelPath });
    const baseAgents = base.agents!;
    const baseDefaults = baseAgents.defaults!;
    const baseMemorySearch = baseDefaults.memorySearch!;

    const first = await getMemorySearchManager({
      cfg: {
        ...base,
        agents: {
          ...baseAgents,
          defaults: {
            ...baseDefaults,
            memorySearch: {
              ...baseMemorySearch,
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
    await first.manager.sync?.({ reason: "test" });
    const callsAfterFirstSync = embedBatchCalls;
    await first.manager.close?.();

    const second = await getMemorySearchManager({
      cfg: {
        ...base,
        agents: {
          ...baseAgents,
          defaults: {
            ...baseDefaults,
            memorySearch: {
              ...baseMemorySearch,
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
    await second.manager.sync?.({ reason: "test" });
    expect(embedBatchCalls).toBeGreaterThan(callsAfterFirstSync);
    const status = second.manager.status();
    expect(status.files).toBeGreaterThan(0);
    await second.manager.close?.();
  });

  it("reuses cached embeddings on forced reindex", async () => {
    const cfg = createCfg({ storePath: indexMainPath, cacheEnabled: true });
    const manager = await getPersistentManager(cfg);
    // Seed the embedding cache once, then ensure a forced reindex doesn't
    // re-embed when the cache is enabled.
    await manager.sync({ reason: "test" });
    const afterFirst = embedBatchCalls;
    expect(afterFirst).toBeGreaterThan(0);

    await manager.sync({ force: true });
    expect(embedBatchCalls).toBe(afterFirst);
  });

  it("finds keyword matches via hybrid search when query embedding is zero", async () => {
    const cfg = createCfg({
      storePath: indexMainPath,
      hybrid: { enabled: true, vectorWeight: 0, textWeight: 1 },
    });
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
    const cfg = createCfg({ storePath: indexVectorPath, vectorEnabled: true });
    const manager = await getPersistentManager(cfg);
    const available = await manager.probeVectorAvailability();
    const status = manager.status();
    expect(status.vector?.enabled).toBe(true);
    expect(typeof status.vector?.available).toBe("boolean");
    expect(status.vector?.available).toBe(available);
  });

  it("rejects reading non-memory paths", async () => {
    const cfg = createCfg({ storePath: indexMainPath });
    const manager = await getPersistentManager(cfg);
    await expect(manager.readFile({ relPath: "NOTES.md" })).rejects.toThrow("path required");
  });

  it("allows reading from additional memory paths and blocks symlinks", async () => {
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "extra.md"), "Extra content.");

    const cfg = createCfg({ storePath: indexExtraPath, extraPaths: [extraDir] });
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
