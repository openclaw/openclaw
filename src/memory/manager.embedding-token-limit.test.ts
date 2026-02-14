import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      maxInputTokens: 8192,
      embedQuery,
      embedBatch,
    },
  }),
}));

describe("memory embedding token limits", () => {
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    embedBatch.mockReset();
    embedQuery.mockReset();
    embedBatch.mockImplementation(async (texts: string[]) => texts.map(() => [0, 1, 0]));
    embedQuery.mockImplementation(async () => [0, 1, 0]);
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-token-"));
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

  it("splits oversized chunks so each embedding input stays <= 8192 UTF-8 bytes", async () => {
    const content = "x".repeat(9500);
    await fs.writeFile(path.join(workspaceDir, "memory", "2026-01-09.md"), content);

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            chunking: { tokens: 10_000, overlap: 0 },
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
    await manager.sync({ reason: "test" });

    const inputs = embedBatch.mock.calls.flatMap((call) => call[0] ?? []);
    expect(inputs.length).toBeGreaterThan(1);
    expect(
      Math.max(...inputs.map((input) => Buffer.byteLength(input, "utf8"))),
    ).toBeLessThanOrEqual(8192);
  });

  it("uses UTF-8 byte estimates when batching multibyte chunks", async () => {
    const line = "😀".repeat(1800);
    const content = `${line}\n${line}\n${line}`;
    await fs.writeFile(path.join(workspaceDir, "memory", "2026-01-10.md"), content);

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            chunking: { tokens: 1000, overlap: 0 },
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
    await manager.sync({ reason: "test" });

    const batchSizes = embedBatch.mock.calls.map(
      (call) => (call[0] as string[] | undefined)?.length ?? 0,
    );
    expect(batchSizes.length).toBe(3);
    expect(batchSizes.every((size) => size === 1)).toBe(true);
    const inputs = embedBatch.mock.calls.flatMap((call) => call[0] ?? []);
    expect(inputs.every((input) => Buffer.byteLength(input, "utf8") <= 8192)).toBe(true);
  });
});
