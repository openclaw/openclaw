import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { MemoryIndexManager } from "./index.js";
import { closeAllMemorySearchManagers } from "./index.js";
import { createOpenAIEmbeddingProviderMock } from "./test-embeddings-mock.js";
import { createMemoryManagerOrThrow } from "./test-manager.js";

const embedBatch = vi.fn(async (_input: string[]): Promise<number[][]> => []);
const embedQuery = vi.fn(async (_input: string): Promise<number[]> => [0.2, 0.2, 0.2]);

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async (_options: unknown) =>
    createOpenAIEmbeddingProviderMock({
      embedQuery: embedQuery as unknown as (input: string) => Promise<number[]>,
      embedBatch: embedBatch as unknown as (input: string[]) => Promise<number[][]>,
    }),
}));

describe("memory search async sync", () => {
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  const buildConfig = (): OpenClawConfig =>
    ({
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            store: { path: indexPath },
            sync: { watch: false, onSessionStart: false, onSearch: true },
            query: { minScore: 0 },
            remote: { batch: { enabled: false, wait: false } },
          },
        },
        list: [{ id: "main", default: true }],
      },
    }) as OpenClawConfig;

  beforeEach(async () => {
    await closeAllMemorySearchManagers();
    embedBatch.mockClear();
    embedBatch.mockImplementation(async (input: string[]) => input.map(() => [0.2, 0.2, 0.2]));
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-async-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"));
    await fs.writeFile(path.join(workspaceDir, "memory", "2026-01-07.md"), "hello\n");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (manager) {
      await manager.close();
      manager = null;
    }
    await closeAllMemorySearchManagers();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("does not await sync when searching", async () => {
    const cfg = buildConfig();
    manager = await createMemoryManagerOrThrow(cfg);

    let releaseSync = () => {};
    const pending = new Promise<void>((resolve) => {
      releaseSync = () => resolve();
    }).finally(() => {
      (manager as unknown as { syncing: Promise<void> | null }).syncing = null;
    });
    const syncMock = vi.fn(async () => {
      (manager as unknown as { syncing: Promise<void> | null }).syncing = pending;
      return pending;
    });
    (manager as unknown as { sync: () => Promise<void> }).sync = syncMock;

    const activeManager = manager;
    if (!activeManager) {
      throw new Error("manager missing");
    }
    await activeManager.search("hello");
    expect(syncMock).toHaveBeenCalledTimes(1);
    releaseSync();
    await vi.waitFor(() => {
      expect((manager as unknown as { syncing: Promise<void> | null }).syncing).toBeNull();
    });
  }, 300_000);

  it("waits for in-flight search sync during close", async () => {
    const cfg = buildConfig();
    manager = await createMemoryManagerOrThrow(cfg);
    let releaseSync = () => {};
    const pendingSync = new Promise<void>((resolve) => {
      releaseSync = () => resolve();
    }).finally(() => {
      (manager as unknown as { syncing: Promise<void> | null }).syncing = null;
    });
    const syncMock = vi.fn(async () => {
      (manager as unknown as { syncing: Promise<void> | null }).syncing = pendingSync;
      return pendingSync;
    });
    (manager as unknown as { dirty: boolean }).dirty = true;
    (manager as unknown as { sync: () => Promise<void> }).sync = syncMock;

    await manager.search("hello");
    await vi.waitFor(() => {
      expect((manager as unknown as { syncing: Promise<void> | null }).syncing).toBe(pendingSync);
    });

    let closed = false;
    const closePromise = manager.close().then(() => {
      closed = true;
    });

    await Promise.resolve();
    expect(closed).toBe(false);

    releaseSync();
    await closePromise;
    manager = null;
  });
});
