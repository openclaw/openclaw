import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import "./test-runtime-mocks.js";
import type { MemoryIndexManager } from "./index.js";

type MemoryIndexModule = typeof import("./index.js");
type ManagerModule = typeof import("./manager.js");

const hoisted = vi.hoisted(() => ({
  providerCreateCalls: 0,
  providerDelayMs: 0,
}));

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => {
    hoisted.providerCreateCalls += 1;
    if (hoisted.providerDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, hoisted.providerDelayMs));
    }
    return {
      requestedProvider: "openai",
      provider: {
        id: "mock",
        model: "mock-embed",
        maxInputTokens: 8192,
        embedQuery: async () => [0, 1, 0],
        embedBatch: async (texts: string[]) => texts.map(() => [0, 1, 0]),
      },
    };
  },
}));

let getMemorySearchManager: MemoryIndexModule["getMemorySearchManager"];
let closeAllMemoryIndexManagers: ManagerModule["closeAllMemoryIndexManagers"];
let RawMemoryIndexManager: ManagerModule["MemoryIndexManager"];

describe("memory manager cache hydration", () => {
  let workspaceDir = "";

  beforeEach(async () => {
    vi.resetModules();
    await import("./test-runtime-mocks.js");
    ({ getMemorySearchManager } = await import("./index.js"));
    ({ closeAllMemoryIndexManagers, MemoryIndexManager: RawMemoryIndexManager } =
      await import("./manager.js"));
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-concurrent-"));
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Hello memory.");
    hoisted.providerCreateCalls = 0;
    hoisted.providerDelayMs = 50;
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  function createMemoryConcurrencyConfig(indexPath: string): OpenClawConfig {
    return {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
  }

  it("deduplicates concurrent manager creation for the same cache key", async () => {
    const indexPath = path.join(workspaceDir, "index.sqlite");
    const cfg = createMemoryConcurrencyConfig(indexPath);

    const results = await Promise.all(
      Array.from(
        { length: 12 },
        async () => await getMemorySearchManager({ cfg, agentId: "main" }),
      ),
    );
    const managers = results
      .map((result) => result.manager)
      .filter((manager): manager is MemoryIndexManager => Boolean(manager));

    expect(managers).toHaveLength(12);
    expect(new Set(managers).size).toBe(1);
    expect(hoisted.providerCreateCalls).toBe(1);

    await managers[0].close();
  });

  it("drains in-flight manager creation during global teardown", async () => {
    const indexPath = path.join(workspaceDir, "index.sqlite");
    const cfg = createMemoryConcurrencyConfig(indexPath);

    hoisted.providerDelayMs = 100;

    const pendingResult = RawMemoryIndexManager.get({ cfg, agentId: "main" });
    await closeAllMemoryIndexManagers();
    const firstManager = await pendingResult;

    const secondManager = await RawMemoryIndexManager.get({ cfg, agentId: "main" });

    expect(firstManager).toBeTruthy();
    expect(secondManager).toBeTruthy();
    expect(Object.is(secondManager, firstManager)).toBe(false);
    expect(hoisted.providerCreateCalls).toBe(2);

    await secondManager?.close?.();
  });
});
