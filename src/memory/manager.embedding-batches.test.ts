import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => [0, 1, 0]));
const embedQuery = vi.fn(async () => [0, 1, 0]);

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
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    embedBatch.mockClear();
    embedQuery.mockClear();
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-mem-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"));
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("splits large files across multiple embedding batches", async () => {
    const line = "a".repeat(200);
    const content = Array.from({ length: 200 }, () => line).join("\n");
    await fs.writeFile(path.join(workspaceDir, "memory", "2026-01-03.md"), content);

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
    if (!result.manager) throw new Error("manager missing");
    manager = result.manager;
    await manager.sync({ force: true });

    const status = manager.status();
    const totalTexts = embedBatch.mock.calls.reduce(
      (sum, call) => sum + (call[0]?.length ?? 0),
      0,
    );
    expect(totalTexts).toBe(status.chunks);
    expect(embedBatch.mock.calls.length).toBeGreaterThan(1);
  });

  it("keeps small files in a single embedding batch", async () => {
    const line = "b".repeat(120);
    const content = Array.from({ length: 12 }, () => line).join("\n");
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
    if (!result.manager) throw new Error("manager missing");
    manager = result.manager;
    await manager.sync({ force: true });

    expect(embedBatch.mock.calls.length).toBe(1);
  });
});
