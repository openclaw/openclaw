import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { DEFAULT_KILOCODE_EMBEDDING_MODEL } from "./embeddings-kilocode.js";
import type {
  EmbeddingProvider,
  EmbeddingProviderResult,
  KilocodeEmbeddingClient,
  OpenAiEmbeddingClient,
} from "./embeddings.js";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

const { createEmbeddingProviderMock } = vi.hoisted(() => ({
  createEmbeddingProviderMock: vi.fn(),
}));

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: createEmbeddingProviderMock,
}));

vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ ok: false, error: "sqlite-vec disabled in tests" }),
}));

function createProvider(id: string): EmbeddingProvider {
  return {
    id,
    model: `${id}-model`,
    embedQuery: async () => [0.1, 0.2, 0.3],
    embedBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
  };
}

function buildConfig(params: {
  workspaceDir: string;
  indexPath: string;
  provider: "openai" | "kilocode";
  fallback?: "none" | "kilocode";
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: params.workspaceDir,
        memorySearch: {
          provider: params.provider,
          model:
            params.provider === "kilocode" ? "mistralai/mistral-embed" : "text-embedding-3-small",
          fallback: params.fallback ?? "none",
          store: { path: params.indexPath, vector: { enabled: false } },
          sync: { watch: false, onSessionStart: false, onSearch: false },
          query: { minScore: 0, hybrid: { enabled: false } },
        },
      },
      list: [{ id: "main", default: true }],
    },
  } as OpenClawConfig;
}

describe("memory manager kilocode provider wiring", () => {
  let workspaceDir = "";
  let indexPath = "";
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    createEmbeddingProviderMock.mockReset();
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-kilocode-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "test");
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = "";
      indexPath = "";
    }
  });

  it("stores kilocode client when kilocode provider is selected", async () => {
    const kilocodeClient: KilocodeEmbeddingClient = {
      baseUrl: "https://api.kilo.ai/api/gateway/",
      headers: { authorization: "Bearer test-key" },
      model: "mistralai/mistral-embed",
    };
    const providerResult: EmbeddingProviderResult = {
      requestedProvider: "kilocode",
      provider: createProvider("kilocode"),
      kilocode: kilocodeClient,
    };
    createEmbeddingProviderMock.mockResolvedValueOnce(providerResult);

    const cfg = buildConfig({ workspaceDir, indexPath, provider: "kilocode" });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    if (!result.manager) {
      throw new Error(`manager missing: ${result.error ?? "no error provided"}`);
    }
    manager = result.manager as unknown as MemoryIndexManager;

    const internal = manager as unknown as { kilocode?: KilocodeEmbeddingClient };
    expect(internal.kilocode).toBe(kilocodeClient);
  });

  it("stores kilocode client after fallback activation", async () => {
    const openAiClient: OpenAiEmbeddingClient = {
      baseUrl: "https://api.openai.com/v1",
      headers: { authorization: "Bearer openai-key" },
      model: "text-embedding-3-small",
    };
    const kilocodeClient: KilocodeEmbeddingClient = {
      baseUrl: "https://api.kilo.ai/api/gateway/",
      headers: { authorization: "Bearer kilocode-key" },
      model: "mistralai/mistral-embed",
    };
    createEmbeddingProviderMock.mockResolvedValueOnce({
      requestedProvider: "openai",
      provider: createProvider("openai"),
      openAi: openAiClient,
    } as EmbeddingProviderResult);
    createEmbeddingProviderMock.mockResolvedValueOnce({
      requestedProvider: "kilocode",
      provider: createProvider("kilocode"),
      kilocode: kilocodeClient,
    } as EmbeddingProviderResult);

    const cfg = buildConfig({ workspaceDir, indexPath, provider: "openai", fallback: "kilocode" });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    if (!result.manager) {
      throw new Error(`manager missing: ${result.error ?? "no error provided"}`);
    }
    manager = result.manager as unknown as MemoryIndexManager;
    const internal = manager as unknown as {
      activateFallbackProvider: (reason: string) => Promise<boolean>;
      openAi?: OpenAiEmbeddingClient;
      kilocode?: KilocodeEmbeddingClient;
    };

    const activated = await internal.activateFallbackProvider("forced test");
    expect(activated).toBe(true);
    expect(internal.openAi).toBeUndefined();
    expect(internal.kilocode).toBe(kilocodeClient);
  });

  it("uses default kilocode model when activating kilocode fallback", async () => {
    const openAiClient: OpenAiEmbeddingClient = {
      baseUrl: "https://api.openai.com/v1",
      headers: { authorization: "Bearer openai-key" },
      model: "text-embedding-3-small",
    };
    const kilocodeClient: KilocodeEmbeddingClient = {
      baseUrl: "https://api.kilo.ai/api/gateway/",
      headers: { authorization: "Bearer kilocode-key" },
      model: DEFAULT_KILOCODE_EMBEDDING_MODEL,
    };
    createEmbeddingProviderMock.mockResolvedValueOnce({
      requestedProvider: "openai",
      provider: createProvider("openai"),
      openAi: openAiClient,
    } as EmbeddingProviderResult);
    createEmbeddingProviderMock.mockResolvedValueOnce({
      requestedProvider: "kilocode",
      provider: createProvider("kilocode"),
      kilocode: kilocodeClient,
    } as EmbeddingProviderResult);

    const cfg = buildConfig({ workspaceDir, indexPath, provider: "openai", fallback: "kilocode" });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    if (!result.manager) {
      throw new Error(`manager missing: ${result.error ?? "no error provided"}`);
    }
    manager = result.manager as unknown as MemoryIndexManager;
    const internal = manager as unknown as {
      activateFallbackProvider: (reason: string) => Promise<boolean>;
      openAi?: OpenAiEmbeddingClient;
      kilocode?: KilocodeEmbeddingClient;
    };

    const activated = await internal.activateFallbackProvider("forced kilocode fallback");
    expect(activated).toBe(true);
    expect(internal.openAi).toBeUndefined();
    expect(internal.kilocode).toBe(kilocodeClient);

    const fallbackCall = createEmbeddingProviderMock.mock.calls[1]?.[0] as
      | { provider?: string; model?: string }
      | undefined;
    expect(fallbackCall?.provider).toBe("kilocode");
    expect(fallbackCall?.model).toBe(DEFAULT_KILOCODE_EMBEDDING_MODEL);
  });

  it("includes org ID in provider key so org changes invalidate the index (SUGGESTION fix)", async () => {
    // Two kilocode clients with different org IDs must produce different provider keys.
    // Without this, switching KILOCODE_ORG_ID would reuse a stale vector index.
    const clientOrgA: KilocodeEmbeddingClient = {
      baseUrl: "https://api.kilo.ai/api/gateway/",
      headers: {
        authorization: "Bearer key",
        "X-KILOCODE-ORGANIZATIONID": "org-a",
      },
      model: DEFAULT_KILOCODE_EMBEDDING_MODEL,
    };
    const clientOrgB: KilocodeEmbeddingClient = {
      baseUrl: "https://api.kilo.ai/api/gateway/",
      headers: {
        authorization: "Bearer key",
        "X-KILOCODE-ORGANIZATIONID": "org-b",
      },
      model: DEFAULT_KILOCODE_EMBEDDING_MODEL,
    };

    // Set up two separate managers — one per org client
    const workspaceDirB = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-kilocode-b-"));
    const indexPathB = path.join(workspaceDirB, "index.sqlite");
    await fs.mkdir(path.join(workspaceDirB, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDirB, "MEMORY.md"), "test");

    createEmbeddingProviderMock.mockResolvedValueOnce({
      requestedProvider: "kilocode",
      provider: createProvider("kilocode"),
      kilocode: clientOrgA,
    } as EmbeddingProviderResult);
    const cfgA = buildConfig({ workspaceDir, indexPath, provider: "kilocode" });
    const resultA = await getMemorySearchManager({ cfg: cfgA, agentId: "main" });
    if (!resultA.manager) {
      throw new Error(`manager A missing: ${resultA.error ?? "no error"}`);
    }
    const managerA = resultA.manager as unknown as MemoryIndexManager;

    createEmbeddingProviderMock.mockResolvedValueOnce({
      requestedProvider: "kilocode",
      provider: createProvider("kilocode"),
      kilocode: clientOrgB,
    } as EmbeddingProviderResult);
    const cfgB = buildConfig({
      workspaceDir: workspaceDirB,
      indexPath: indexPathB,
      provider: "kilocode",
    });
    const resultB = await getMemorySearchManager({ cfg: cfgB, agentId: "main" });
    if (!resultB.manager) {
      throw new Error(`manager B missing: ${resultB.error ?? "no error"}`);
    }
    const managerB = resultB.manager as unknown as MemoryIndexManager;

    try {
      const keyA = (managerA as unknown as { providerKey: string }).providerKey;
      const keyB = (managerB as unknown as { providerKey: string }).providerKey;
      expect(keyA).not.toBe(keyB);
    } finally {
      await managerA.close();
      await managerB.close();
      await fs.rm(workspaceDirB, { recursive: true, force: true });
    }
  });
});
