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

  it("awaits sync before returning search results", async () => {
    const cfg = buildConfig();
    manager = await createMemoryManagerOrThrow(cfg);

    // Track whether sync completed before search returned
    const callOrder: string[] = [];
    const originalSync = (
      manager as unknown as { sync: (...args: unknown[]) => Promise<void> }
    ).sync.bind(manager);

    (manager as unknown as { sync: (...args: unknown[]) => Promise<void> }).sync = vi.fn(
      async (...args: unknown[]) => {
        callOrder.push("sync-start");
        await originalSync(...args);
        callOrder.push("sync-end");
      },
    );

    await manager.search("hello");
    callOrder.push("search-done");

    // Sync must have started AND completed before search resolved
    expect(callOrder.indexOf("sync-start")).toBeLessThan(callOrder.indexOf("search-done"));
    expect(callOrder.indexOf("sync-end")).toBeLessThan(callOrder.indexOf("search-done"));
  });

  it("blocks search until sync completes (no race condition)", async () => {
    const cfg = buildConfig();
    manager = await createMemoryManagerOrThrow(cfg);

    let syncCompleted = false;
    let resolveSync: () => void;
    const syncGate = new Promise<void>((resolve) => {
      resolveSync = resolve;
    });

    // Replace sync with a gated version
    (manager as unknown as { sync: () => Promise<void> }).sync = vi.fn(async () => {
      await syncGate;
      syncCompleted = true;
    });

    // Start search (will block on sync)
    let searchDone = false;
    const searchPromise = manager.search("hello").then(() => {
      searchDone = true;
    });

    // Give microtasks time to settle
    await new Promise((r) => setTimeout(r, 50));

    // Search should NOT have completed (sync is still blocked)
    expect(searchDone).toBe(false);
    expect(syncCompleted).toBe(false);

    // Release sync
    resolveSync!();
    await searchPromise;

    expect(syncCompleted).toBe(true);
    expect(searchDone).toBe(true);
  });
});
