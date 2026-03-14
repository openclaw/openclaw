import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryIndexManager } from "./index.js";
import "./test-runtime-mocks.js";

// Switchable provider mock: starts with a real provider, can be toggled to null.
let providerEnabled = true;

const embedText = (text: string) => {
  const lower = text.toLowerCase();
  return [lower.split("alpha").length - 1, lower.split("beta").length - 1];
};

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => {
    if (!providerEnabled) {
      return {
        requestedProvider: "auto",
        provider: null,
        providerUnavailableReason: "no API keys configured",
      };
    }
    return {
      requestedProvider: "openai",
      provider: {
        id: "openai",
        model: "text-embedding-3-small",
        embedQuery: async (text: string) => embedText(text),
        embedBatch: async (texts: string[]) => texts.map(embedText),
      },
      openAi: {
        baseUrl: "https://api.openai.com/v1",
        headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
        model: "text-embedding-3-small",
      },
    };
  },
}));

describe("provider → no-provider FTS transition", () => {
  let fixtureRoot = "";
  let workspaceDir = "";
  let memoryDir = "";

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-transition-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX", "1");
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    providerEnabled = true;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  type TestCfg = Parameters<typeof import("./index.js").getMemorySearchManager>[0]["cfg"];

  function createCfg(storePath: string): TestCfg {
    return {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            store: { path: storePath, vector: { enabled: false } },
            chunking: { tokens: 4000, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: {
              minScore: 0,
              hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
            },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
  }

  it("does not leak old provider FTS rows when switching to no-provider mode", async () => {
    const { getMemorySearchManager } = await import("./index.js");
    const storePath = path.join(workspaceDir, `transition-${randomUUID()}.sqlite`);
    const memFile = path.join(memoryDir, `transition-${randomUUID()}.md`);
    await fs.writeFile(memFile, "Alpha transition content with unique kappa keyword.");

    // Phase 1: index with a provider.
    providerEnabled = true;
    const cfg = createCfg(storePath);
    const result1 = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager1 = result1.manager as MemoryIndexManager;
    await manager1.sync({ reason: "test" });

    const withProvider = await manager1.search("kappa");
    expect(withProvider.length).toBeGreaterThan(0);
    await manager1.close();

    // Remove the file so that it becomes stale.
    await fs.rm(memFile);

    // Phase 2: switch to no-provider and force reindex on the same DB.
    providerEnabled = false;
    const result2 = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager2 = result2.manager as MemoryIndexManager;
    await manager2.sync({ force: true });

    // Old provider's FTS rows for the removed file should not leak.
    const afterTransition = await manager2.search("kappa");
    expect(afterTransition.length).toBe(0);

    await manager2.close();
  });
});
