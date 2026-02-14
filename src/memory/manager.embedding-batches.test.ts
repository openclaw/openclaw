import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => [0, 1, 0]));
const embedQuery = vi.fn(async () => [0, 1, 0]);

vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ ok: false, error: "sqlite-vec disabled in tests" }),
}));

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "mock",
      model: "mock-embed",
      embedQuery,
      embedBatch,
    },
  }),
}));

describe("memory embedding batches", () => {
  let fixtureRoot: string;
  let caseId = 0;
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    embedBatch.mockClear();
    embedQuery.mockClear();
    workspaceDir = path.join(fixtureRoot, `case-${++caseId}`);
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
  });

  it("splits large files across multiple embedding batches", async () => {
    // Keep this small but above the embedding batch byte threshold (8k) so we
    // exercise multi-batch behavior without generating lots of chunks/DB rows.
    const line = "a".repeat(5000);
    const content = [line, line].join("\n");
    await fs.writeFile(path.join(workspaceDir, "memory", "2026-01-03.md"), content);

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            chunking: { tokens: 1250, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0 },
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
    const updates: Array<{ completed: number; total: number; label?: string }> = [];
    await manager.sync({
      force: true,
      progress: (update) => {
        updates.push(update);
      },
    });

    const status = manager.status();
    const totalTexts = embedBatch.mock.calls.reduce((sum, call) => sum + (call[0]?.length ?? 0), 0);
    expect(totalTexts).toBe(status.chunks);
    expect(embedBatch.mock.calls.length).toBeGreaterThan(1);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.some((update) => update.label?.includes("/"))).toBe(true);
    const last = updates[updates.length - 1];
    expect(last?.total).toBeGreaterThan(0);
    expect(last?.completed).toBe(last?.total);
  });

  it("keeps small files in a single embedding batch", async () => {
    const line = "b".repeat(120);
    const content = Array.from({ length: 4 }, () => line).join("\n");
    await fs.writeFile(path.join(workspaceDir, "memory", "2026-01-04.md"), content);

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            chunking: { tokens: 200, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0 },
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

    expect(embedBatch.mock.calls.length).toBe(1);
  });

  it("retries embeddings on transient rate limit and 5xx errors", async () => {
    const line = "d".repeat(120);
    const content = Array.from({ length: 4 }, () => line).join("\n");
    await fs.writeFile(path.join(workspaceDir, "memory", "2026-01-06.md"), content);

    const transientErrors = [
      "openai embeddings failed: 429 rate limit",
      "openai embeddings failed: 502 Bad Gateway (cloudflare)",
    ];
    let calls = 0;
    embedBatch.mockImplementation(async (texts: string[]) => {
      calls += 1;
      const transient = transientErrors[calls - 1];
      if (transient) {
        throw new Error(transient);
      }
      return texts.map(() => [0, 1, 0]);
    });

    const realSetTimeout = setTimeout;
    const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      const delay = typeof timeout === "number" ? timeout : 0;
      if (delay > 0 && delay <= 2000) {
        return realSetTimeout(handler, 0, ...args);
      }
      return realSetTimeout(handler, delay, ...args);
    }) as typeof setTimeout);

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            chunking: { tokens: 200, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0 },
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
    try {
      await manager.sync({ force: true });
    } finally {
      setTimeoutSpy.mockRestore();
    }

    expect(calls).toBe(3);
  }, 10000);

  it("skips empty chunks so embeddings input stays valid", async () => {
    await fs.writeFile(path.join(workspaceDir, "memory", "2026-01-07.md"), "\n\n\n");

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0 },
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

    const inputs = embedBatch.mock.calls.flatMap((call) => call[0] ?? []);
    expect(inputs).not.toContain("");
  });
});
