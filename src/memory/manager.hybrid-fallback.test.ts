import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { MemoryIndexManager } from "./index.js";
import { createMemoryManagerOrThrow } from "./test-manager.js";
import "./test-runtime-mocks.js";

const embedBatch = vi.fn(
  async (input: string[]): Promise<number[][]> => input.map(() => [0, 1, 0]),
);
const embedQuery = vi.fn(async (): Promise<number[]> => [0, 0, 0]);

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "local",
    provider: {
      id: "local",
      model: "mock-local",
      maxInputTokens: 8192,
      embedQuery,
      embedBatch,
    },
  }),
}));

describe("MemoryIndexManager hybrid search fallback", () => {
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  const buildConfig = (): OpenClawConfig =>
    ({
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "local",
            fallback: "none",
            model: "mock-local",
            store: { path: indexPath, vector: { enabled: false } },
            chunking: { tokens: 4000, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: {
              minScore: 0.35,
              hybrid: { enabled: true, vectorWeight: 0.7, textWeight: 0.3 },
            },
            cache: { enabled: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    }) as OpenClawConfig;

  beforeEach(async () => {
    vi.stubEnv("OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX", "1");
    embedBatch.mockClear();
    embedQuery.mockClear();

    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-hybrid-fallback-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"));
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-02-27.md"),
      "- canary: qzv91-lime-orbit\n",
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("returns keyword results when query embedding is all zeros", async () => {
    manager = await createMemoryManagerOrThrow(buildConfig());
    await manager.sync({ reason: "test", force: true });

    const results = await manager.search("qzv91-lime-orbit");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.path).toBe("memory/2026-02-27.md");
    expect(results[0]?.score).toBeGreaterThanOrEqual(0.35);
    expect(embedQuery).toHaveBeenCalledTimes(1);
  });
});
