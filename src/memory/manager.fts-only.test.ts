import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";
import "./test-runtime-mocks.js";

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: null,
    providerUnavailableReason: "No API key found for provider",
  }),
}));

describe("FTS-only memory search", () => {
  let fixtureRoot = "";
  let workspaceDir = "";
  let memoryDir = "";

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fts-only-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, "notes.md"),
      "# Notes\nSergei prefers TypeScript.\nImportant meeting on Monday.",
    );
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX", "1");
  });

  type TestCfg = Parameters<typeof getMemorySearchManager>[0]["cfg"];

  function createCfg(storePath: string): TestCfg {
    return {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            store: { path: storePath, vector: { enabled: false } },
            chunking: { tokens: 4000, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: {
              minScore: 0,
              hybrid: { enabled: true },
            },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
  }

  it("indexes and finds results via FTS when no embedding provider is available", async () => {
    const storePath = path.join(workspaceDir, `fts-only-${Date.now()}.sqlite`);
    const cfg = createCfg(storePath);
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    const manager = result.manager as MemoryIndexManager;

    try {
      const status = manager.status();
      expect(status.provider).toBe("none");

      await manager.sync({ reason: "test" });

      const results = await manager.search("Sergei");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.snippet).toContain("Sergei");
    } finally {
      await manager.close();
    }
  });

  it("syncs automatically on first search when no explicit sync was called", async () => {
    const storePath = path.join(workspaceDir, `fts-autosync-${Date.now()}.sqlite`);
    const cfg = createCfg(storePath);
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    const manager = result.manager as MemoryIndexManager;

    try {
      const results = await manager.search("Sergei");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.snippet).toContain("Sergei");
    } finally {
      await manager.close();
    }
  });

  it("reports fts-only search mode in status", async () => {
    const storePath = path.join(workspaceDir, `fts-status-${Date.now()}.sqlite`);
    const cfg = createCfg(storePath);
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    const manager = result.manager as MemoryIndexManager;

    try {
      const status = manager.status();
      expect(status.provider).toBe("none");
      expect(status.custom).toEqual(expect.objectContaining({ searchMode: "fts-only" }));
    } finally {
      await manager.close();
    }
  });

  it("removes stale files during FTS-only sync", async () => {
    const storePath = path.join(workspaceDir, `fts-stale-${Date.now()}.sqlite`);
    const stalePath = path.join(memoryDir, "stale.md");
    await fs.writeFile(stalePath, "Stale content to be removed.");
    const cfg = createCfg(storePath);
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    const manager = result.manager as MemoryIndexManager;

    try {
      await manager.sync({ reason: "test" });
      const before = await manager.search("Stale");
      expect(before.length).toBeGreaterThan(0);

      await fs.rm(stalePath);
      (manager as unknown as { dirty: boolean }).dirty = true;
      await manager.sync({ force: true });

      const after = await manager.search("Stale");
      expect(after.length).toBe(0);
    } finally {
      await manager.close();
    }
  });
});
