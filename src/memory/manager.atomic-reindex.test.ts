import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

let shouldFail = false;

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
          if (shouldFail) {
            throw new Error("embedding failure");
          }
          return texts.map((_, index) => [index + 1, 0, 0]);
        },
      },
    }),
  };
});

vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ ok: false, error: "sqlite-vec disabled in tests" }),
}));

describe("memory manager atomic reindex", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-atomic-"));
  });

  beforeEach(async () => {
    vi.stubEnv("OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX", "0");
    shouldFail = false;
    workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(workspaceDir, { recursive: true });
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"));
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Hello memory.");
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("keeps the prior index when a full reindex fails", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            cache: { enabled: false },
            // Perf: keep test indexes to a single chunk to reduce sqlite work.
            chunking: { tokens: 4000, overlap: 0 },
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

    await manager.sync({ force: true });
    const beforeStatus = manager.status();
    expect(beforeStatus.chunks).toBeGreaterThan(0);

    shouldFail = true;
    await expect(manager.sync({ force: true })).rejects.toThrow("embedding failure");

    const afterStatus = manager.status();
    expect(afterStatus.chunks).toBeGreaterThan(0);
  });
});
