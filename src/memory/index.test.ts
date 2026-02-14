import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

let embedBatchCalls = 0;

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
  let fixtureCount = 0;
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-fixtures-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    embedBatchCalls = 0;
    workspaceDir = path.join(fixtureRoot, `case-${fixtureCount++}`);
    await fs.mkdir(workspaceDir, { recursive: true });
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"));
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-01-12.md"),
      "# Log\nAlpha memory line.\nZebra memory line.",
    );
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
  });

  it("indexes memory files and searches by vector", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: true },
            query: { minScore: 0, hybrid: { enabled: false } },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;
    await result.manager.sync({ force: true });
    const results = await result.manager.search("alpha");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.path).toContain("memory/2026-01-12.md");
    const status = result.manager.status();
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
    const base = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            store: { path: indexPath },
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
    await first.manager.sync({ force: true });
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
    manager = second.manager;
    await second.manager.sync({ reason: "test" });
    expect(embedBatchCalls).toBeGreaterThan(callsAfterFirstSync);
    const status = second.manager.status();
    expect(status.files).toBeGreaterThan(0);
  });

  it("reuses cached embeddings on forced reindex", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0, hybrid: { enabled: false } },
            cache: { enabled: true },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;
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
            store: { path: indexPath, vector: { enabled: false } },
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
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;

    const status = manager.status();
    if (!status.fts?.available) {
      return;
    }

    await manager.sync({ force: true });
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
            store: { path: indexPath },
            sync: { watch: false, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;
    const available = await result.manager.probeVectorAvailability();
    const status = result.manager.status();
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
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: true },
            query: { minScore: 0, hybrid: { enabled: false } },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;
    await expect(result.manager.readFile({ relPath: "NOTES.md" })).rejects.toThrow("path required");
  });

  it("allows reading from additional memory paths and blocks symlinks", async () => {
    const extraDir = path.join(workspaceDir, "extra");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "extra.md"), "Extra content.");

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: true },
            query: { minScore: 0, hybrid: { enabled: false } },
            extraPaths: [extraDir],
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;
    await expect(result.manager.readFile({ relPath: "extra/extra.md" })).resolves.toEqual({
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
      await expect(result.manager.readFile({ relPath: "extra/linked.md" })).rejects.toThrow(
        "path required",
      );
    }
  });
});
