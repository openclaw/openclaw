import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbedBatchMock, resetEmbeddingMocks } from "./embedding.test-mocks.js";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

const embedBatch = getEmbedBatchMock();

describe("memory embedding batches", () => {
  let fixtureRoot: string;
  let workspaceDir: string;
  let memoryDir: string;
  let indexPathLarge: string;
  let indexPathSmall: string;
  let managerLarge: MemoryIndexManager | null = null;
  let managerSmall: MemoryIndexManager | null = null;

  function resetManagerForTest(manager: MemoryIndexManager | null) {
    if (!manager) {
      throw new Error("manager missing");
    }
    (manager as unknown as { resetIndex: () => void }).resetIndex();
    (manager as unknown as { dirty: boolean }).dirty = true;
  }

  function createCfg(params: { indexPath: string; tokens: number }) {
    return {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: params.indexPath, vector: { enabled: false } },
            chunking: { tokens: params.tokens, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0, hybrid: { enabled: false } },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
  }

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    memoryDir = path.join(workspaceDir, "memory");
    indexPathLarge = path.join(fixtureRoot, "index.large.sqlite");
    indexPathSmall = path.join(fixtureRoot, "index.small.sqlite");
    await fs.mkdir(memoryDir, { recursive: true });

    const large = await getMemorySearchManager({
      cfg: createCfg({ indexPath: indexPathLarge, tokens: 1250 }),
      agentId: "main",
    });
    expect(large.manager).not.toBeNull();
    if (!large.manager) {
      throw new Error("manager missing");
    }
    managerLarge = large.manager;

    const small = await getMemorySearchManager({
      cfg: createCfg({ indexPath: indexPathSmall, tokens: 200 }),
      agentId: "main",
    });
    expect(small.manager).not.toBeNull();
    if (!small.manager) {
      throw new Error("manager missing");
    }
    managerSmall = small.manager;
  });

  afterAll(async () => {
    if (managerLarge) {
      await managerLarge.close();
      managerLarge = null;
    }
    if (managerSmall) {
      await managerSmall.close();
      managerSmall = null;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    resetEmbeddingMocks();

    await fs.rm(memoryDir, { recursive: true, force: true });
    await fs.mkdir(memoryDir, { recursive: true });
  });

  it("splits large files across multiple embedding batches", async () => {
    // Keep this small but above the embedding batch byte threshold (8k) so we
    // exercise multi-batch behavior without generating lots of chunks/DB rows.
    const line = "a".repeat(4200);
    const content = [line, line].join("\n");
    await fs.writeFile(path.join(memoryDir, "2026-01-03.md"), content);
    resetManagerForTest(managerLarge);
    if (!managerLarge) {
      throw new Error("manager missing");
    }
    const updates: Array<{ completed: number; total: number; label?: string }> = [];
    await managerLarge.sync({
      progress: (update) => {
        updates.push(update);
      },
    });

    const status = managerLarge.status();
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
    await fs.writeFile(path.join(memoryDir, "2026-01-04.md"), content);
    resetManagerForTest(managerSmall);
    if (!managerSmall) {
      throw new Error("manager missing");
    }
    await managerSmall.sync({ reason: "test" });

    expect(embedBatch.mock.calls.length).toBe(1);
  });

  it("retries embeddings on transient rate limit and 5xx errors", async () => {
    const line = "d".repeat(120);
    const content = Array.from({ length: 4 }, () => line).join("\n");
    await fs.writeFile(path.join(memoryDir, "2026-01-06.md"), content);

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
    resetManagerForTest(managerSmall);
    if (!managerSmall) {
      throw new Error("manager missing");
    }
    try {
      await managerSmall.sync({ reason: "test" });
    } finally {
      setTimeoutSpy.mockRestore();
    }

    expect(calls).toBe(3);
  }, 10000);

  it("skips empty chunks so embeddings input stays valid", async () => {
    await fs.writeFile(path.join(memoryDir, "2026-01-07.md"), "\n\n\n");
    resetManagerForTest(managerSmall);
    if (!managerSmall) {
      throw new Error("manager missing");
    }
    await managerSmall.sync({ reason: "test" });

    const inputs = embedBatch.mock.calls.flatMap((call) => call[0] ?? []);
    expect(inputs).not.toContain("");
  });
});
