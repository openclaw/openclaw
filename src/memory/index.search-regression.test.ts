import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { MemoryIndexManager } from "./index.js";

type EmbeddingTestMocksModule = typeof import("./embedding.test-mocks.js");
type TestManagerHelpersModule = typeof import("./test-manager-helpers.js");

function embedText(text: string) {
  const lower = text.toLowerCase();
  const alpha = lower.split("alpha").length - 1;
  const beta = lower.split("beta").length - 1;
  const image = lower.split("image").length - 1;
  const audio = lower.split("audio").length - 1;
  return [alpha, beta, image, audio];
}

describe("memory index search regressions", () => {
  let fixtureRoot = "";
  let manager: MemoryIndexManager | null = null;
  let getEmbedBatchMock: EmbeddingTestMocksModule["getEmbedBatchMock"];
  let getEmbedQueryMock: EmbeddingTestMocksModule["getEmbedQueryMock"];
  let resetEmbeddingMocks: EmbeddingTestMocksModule["resetEmbeddingMocks"];
  let getRequiredMemoryIndexManager: TestManagerHelpersModule["getRequiredMemoryIndexManager"];
  let workspaceDir = "";
  let indexPath = "";

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-index-search-"));
  });

  beforeEach(async () => {
    vi.resetModules();
    const embeddingMocks = await import("./embedding.test-mocks.js");
    getEmbedBatchMock = embeddingMocks.getEmbedBatchMock;
    getEmbedQueryMock = embeddingMocks.getEmbedQueryMock;
    resetEmbeddingMocks = embeddingMocks.resetEmbeddingMocks;
    ({ getRequiredMemoryIndexManager } = await import("./test-manager-helpers.js"));

    resetEmbeddingMocks();
    getEmbedBatchMock().mockImplementation(async (texts: string[]) => texts.map(embedText));
    getEmbedQueryMock().mockImplementation(async (text: string) => embedText(text));

    workspaceDir = path.join(fixtureRoot, randomUUID());
    indexPath = path.join(workspaceDir, "index.sqlite");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, "2026-01-12.md"),
      "# Log\nAlpha memory line.\nZebra memory line.",
    );
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  function createCfg(params: {
    hybrid?: { enabled: boolean; vectorWeight?: number; textWeight?: number };
    minScore?: number;
  }): OpenClawConfig {
    return {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            chunking: { tokens: 4000, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: true },
            query: {
              minScore: params.minScore ?? 0,
              hybrid: params.hybrid ?? { enabled: false },
            },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
  }

  it("indexes memory files and searches", async () => {
    manager = await getRequiredMemoryIndexManager({
      cfg: createCfg({
        hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
      }),
      agentId: "main",
    });

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

  it("preserves keyword-only hybrid hits when minScore exceeds text weight", async () => {
    manager = await getRequiredMemoryIndexManager({
      cfg: createCfg({
        minScore: 0.35,
        hybrid: { enabled: true, vectorWeight: 0.7, textWeight: 0.3 },
      }),
      agentId: "main",
    });

    const status = manager.status();
    expect(status.fts?.available).toBe(true);

    await manager.sync({ reason: "test" });
    const results = await manager.search("zebra");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.path).toContain("memory/2026-01-12.md");
  });
});
