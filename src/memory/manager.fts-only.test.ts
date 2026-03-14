import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";
import "./test-runtime-mocks.js";

// Mock createEmbeddingProvider to return null provider (no embedding available).
vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "auto",
    provider: null,
    providerUnavailableReason: "no API keys configured",
  }),
}));

describe("memory FTS-only indexing (no embedding provider)", () => {
  let fixtureRoot = "";
  let workspaceDir = "";
  let memoryDir = "";

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-fts-only-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, "2026-01-15.md"),
      "# Notes\nAlpha memory line.\nZebra memory line.\nBeta detail here.",
    );
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX", "1");
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  });

  type TestCfg = Parameters<typeof getMemorySearchManager>[0]["cfg"];

  function createCfg(storePath: string): TestCfg {
    return {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "",
            store: { path: storePath, vector: { enabled: false } },
            chunking: { tokens: 4000, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: {
              minScore: 0,
              hybrid: { enabled: true, vectorWeight: 0, textWeight: 1 },
            },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
  }

  it("indexes memory files and finds them via FTS search without an embedding provider", async () => {
    const storePath = path.join(workspaceDir, `fts-only-${randomUUID()}.sqlite`);
    const cfg = createCfg(storePath);
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    const manager = result.manager as MemoryIndexManager;

    await manager.sync({ reason: "test" });

    const status = manager.status();
    expect(status.files).toBeGreaterThan(0);
    expect(status.chunks).toBeGreaterThan(0);

    const results = await manager.search("zebra");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.path).toContain("memory/2026-01-15.md");

    await manager.close();
  });

  it("cleans up stale FTS entries when a memory file is removed", async () => {
    const storePath = path.join(workspaceDir, `fts-stale-${randomUUID()}.sqlite`);
    const tempFile = path.join(memoryDir, `temp-${randomUUID()}.md`);
    await fs.writeFile(tempFile, "Temporary gamma content for stale test.");

    const cfg = createCfg(storePath);
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = result.manager as MemoryIndexManager;

    await manager.sync({ reason: "test" });

    // Verify the temp file was indexed.
    const beforeResults = await manager.search("gamma");
    expect(beforeResults.length).toBeGreaterThan(0);

    // Remove the temp file and re-sync.
    await fs.rm(tempFile);
    (manager as unknown as { dirty: boolean }).dirty = true;
    await manager.sync({ reason: "test" });

    // Stale FTS entries should be gone.
    const afterResults = await manager.search("gamma");
    expect(afterResults.length).toBe(0);

    await manager.close();
  });

  it("reindexes correctly when file content changes", async () => {
    const storePath = path.join(workspaceDir, `fts-reindex-${randomUUID()}.sqlite`);
    const mutableFile = path.join(memoryDir, `mutable-${randomUUID()}.md`);
    await fs.writeFile(mutableFile, "Original delta content.");

    const cfg = createCfg(storePath);
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = result.manager as MemoryIndexManager;

    await manager.sync({ reason: "test" });
    const firstResults = await manager.search("delta");
    expect(firstResults.length).toBeGreaterThan(0);

    // Update content, close manager, and create a fresh one to force full reindex.
    await fs.writeFile(mutableFile, "Updated epsilon content only.");
    await manager.close();

    const result2 = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager2 = result2.manager as MemoryIndexManager;
    await manager2.sync({ force: true });

    const deltaResults = await manager2.search("delta");
    expect(deltaResults.length).toBe(0);

    const epsilonResults = await manager2.search("epsilon");
    expect(epsilonResults.length).toBeGreaterThan(0);

    await fs.rm(mutableFile);
    await manager2.close();
  });
});
