/**
 * manager-routing-wiring.test.ts
 *
 * 验证 MemoryIndexManager.get() 在创建 embedding provider 后，
 * 将其传给 routing instance 的 setEmbeddingProvider。
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

// ---------------------------------------------------------------------------
// Runtime mocks — chokidar 和 sqlite-vec 在测试中不可用
// ---------------------------------------------------------------------------

vi.mock("chokidar", () => ({
  default: {
    watch: () => ({ on: () => {}, close: async () => {} }),
  },
  watch: () => ({ on: () => {}, close: async () => {} }),
}));

vi.mock("../sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({
    ok: false,
    error: "sqlite-vec disabled in tests",
  }),
}));

// ---------------------------------------------------------------------------
// Hoisted spy + fake provider
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => {
  const setEmbeddingProviderSpy = vi.fn();
  const fakeProvider = {
    id: "fake-provider",
    model: "fake-model",
    embedQuery: vi.fn(async () => [0, 1, 0]),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0, 1, 0])),
  };
  return { setEmbeddingProviderSpy, fakeProvider };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../embeddings.js", () => ({
  createEmbeddingProvider: vi.fn(async () => ({
    requestedProvider: "openai",
    provider: hoisted.fakeProvider,
  })),
}));

vi.mock("../../gateway/routing/routing-instance.js", () => ({
  getRoutingInstance: vi.fn(() => ({
    setEmbeddingProvider: hoisted.setEmbeddingProviderSpy,
    selector: { resolveModels: () => [] },
    healthTracker: {},
    budgetTracker: {},
    reviewGate: { shouldReview: () => false, isAutoMode: () => false },
    serialize: () => ({ health: "", budget: "" }),
    deserialize: () => {},
    semanticRouter: undefined,
  })),
  resetRoutingInstance: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemoryIndexManager — routing wiring", () => {
  let fixtureRoot: string | undefined;
  let workspaceDir: string;
  let indexPath: string;

  beforeEach(async () => {
    hoisted.setEmbeddingProviderSpy.mockClear();
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-routing-wire-"));
    workspaceDir = fixtureRoot;
    indexPath = path.join(fixtureRoot, "index.sqlite");
    await fs.mkdir(path.join(fixtureRoot, "memory"), { recursive: true });
  });

  afterEach(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("get() 调用 setEmbeddingProvider，传入 fake provider", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            chunking: { tokens: 200, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0, hybrid: { enabled: false } },
          },
        },
        list: [{ id: "main", default: true }],
      },
      routing: {
        default_task_type: "fallback",
        cooldown_seconds: 30,
        antiflap_enabled: false,
        triggers: {},
        deny_list: [],
        semantic_router: { enabled: true, threshold: 0.68 },
      },
    } as unknown as OpenClawConfig;

    // Import after mocks are in place
    const { MemoryIndexManager } = await import("../manager.js");
    const manager = await MemoryIndexManager.get({ cfg, agentId: "main" });

    expect(manager).not.toBeNull();
    expect(hoisted.setEmbeddingProviderSpy).toHaveBeenCalledTimes(1);
    expect(hoisted.setEmbeddingProviderSpy).toHaveBeenCalledWith(
      hoisted.fakeProvider,
      0.68, // semantic_router.threshold
    );

    if (manager) {
      await manager.close();
    }
  });

  it("routing 配置缺失时不调用 setEmbeddingProvider", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            chunking: { tokens: 200, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0, hybrid: { enabled: false } },
          },
        },
        list: [{ id: "main", default: true }],
      },
      // 无 routing 字段
    } as unknown as OpenClawConfig;

    const { MemoryIndexManager } = await import("../manager.js");
    const manager = await MemoryIndexManager.get({ cfg, agentId: "main" });

    expect(manager).not.toBeNull();
    // 无 routing config → 不调用 setEmbeddingProvider
    expect(hoisted.setEmbeddingProviderSpy).not.toHaveBeenCalled();

    if (manager) {
      await manager.close();
    }
  });
});
