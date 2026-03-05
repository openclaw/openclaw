import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { MemoryIndexManager } from "./index.js";
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
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("awaits sync when searching so results are up-to-date", async () => {
    const cfg = buildConfig();
    manager = await createMemoryManagerOrThrow(cfg);

    let syncResolved = false;
    let resolveSync: () => void = () => {};
    const syncGate = new Promise<void>((resolve) => {
      resolveSync = resolve;
    });
    const syncMock = vi.fn(async () => {
      await syncGate;
      syncResolved = true;
    });
    (manager as unknown as { sync: () => Promise<void> }).sync = syncMock;

    const activeManager = manager;
    if (!activeManager) {
      throw new Error("manager missing");
    }

    // Start search — it should block on sync.
    const searchPromise = activeManager.search("hello");

    // Sync hasn't resolved yet.
    await Promise.resolve();
    expect(syncResolved).toBe(false);

    // Release sync — search should now complete.
    resolveSync();
    await searchPromise;
    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(syncResolved).toBe(true);
  });

  it("skips sync for empty/whitespace queries", async () => {
    const cfg = buildConfig();
    manager = await createMemoryManagerOrThrow(cfg);

    const syncMock = vi.fn(async () => {});
    (manager as unknown as { sync: () => Promise<void> }).sync = syncMock;

    const result = await manager.search("   ");
    expect(result).toEqual([]);
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("close waits for pending sync started by search", async () => {
    const cfg = buildConfig();
    let releaseSync = () => {};
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = () => resolve();
    });
    embedBatch.mockImplementation(async (input: string[]) => {
      await syncGate;
      return input.map(() => [0.3, 0.2, 0.1]);
    });

    manager = await createMemoryManagerOrThrow(cfg);

    // search() awaits sync, which blocks on embedBatch → syncGate.
    // Fire search in the background so we can call close() while sync
    // is in progress.
    const searchPromise = manager.search("hello");

    // Give search enough time to enter sync (start embedBatch).
    await new Promise((r) => setTimeout(r, 100));

    // Release the gate so sync + search complete.
    releaseSync();
    await searchPromise;

    // close() should succeed cleanly after search + sync have finished.
    await manager.close();
    manager = null;
  });
});
