import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { DEFAULT_OLLAMA_EMBEDDING_MODEL } from "./embeddings-ollama.js";
import type {
  EmbeddingProvider,
  EmbeddingProviderResult,
  MistralEmbeddingClient,
  OllamaEmbeddingClient,
  OpenAiEmbeddingClient,
} from "./embeddings.js";
import type { MemoryIndexManager } from "./index.js";

const { createEmbeddingProviderMock } = vi.hoisted(() => ({
  createEmbeddingProviderMock: vi.fn(),
}));

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: createEmbeddingProviderMock,
}));

vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ ok: false, error: "sqlite-vec disabled in tests" }),
}));

type MemoryIndexModule = typeof import("./index.js");

let getMemorySearchManager: MemoryIndexModule["getMemorySearchManager"];
let closeAllMemorySearchManagers: MemoryIndexModule["closeAllMemorySearchManagers"];

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
  provider: "openai" | "mistral";
  fallback?: "none" | "mistral" | "ollama";
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: params.workspaceDir,
        memorySearch: {
          provider: params.provider,
          model: params.provider === "mistral" ? "mistral/mistral-embed" : "text-embedding-3-small",
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

describe("memory manager mistral provider wiring", () => {
  let workspaceDir = "";
  let indexPath = "";
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    vi.resetModules();
    ({ getMemorySearchManager, closeAllMemorySearchManagers } = await import("./index.js"));
    vi.clearAllMocks();
    createEmbeddingProviderMock.mockReset();
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-mistral-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "test");
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await closeAllMemorySearchManagers();
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = "";
      indexPath = "";
    }
  });

  it("stores mistral client when mistral provider is selected", async () => {
    const mistralClient: MistralEmbeddingClient = {
      baseUrl: "https://api.mistral.ai/v1",
      headers: { authorization: "Bearer test-key" },
      model: "mistral-embed",
    };
    const providerResult: EmbeddingProviderResult = {
      requestedProvider: "mistral",
      provider: createProvider("mistral"),
      mistral: mistralClient,
    };
    createEmbeddingProviderMock.mockResolvedValueOnce(providerResult);

    const cfg = buildConfig({ workspaceDir, indexPath, provider: "mistral" });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    if (!result.manager) {
      throw new Error(`manager missing: ${result.error ?? "no error provided"}`);
    }
    manager = result.manager as unknown as MemoryIndexManager;
    await manager.probeEmbeddingAvailability();

    const internal = manager as unknown as {
      ensureProviderInitialized: () => Promise<void>;
      mistral?: MistralEmbeddingClient;
    };
    await internal.ensureProviderInitialized();
    expect(internal.mistral).toBe(mistralClient);
  });

  it("stores mistral client after fallback activation", async () => {
    const openAiClient: OpenAiEmbeddingClient = {
      baseUrl: "https://api.openai.com/v1",
      headers: { authorization: "Bearer openai-key" },
      model: "text-embedding-3-small",
    };
    const mistralClient: MistralEmbeddingClient = {
      baseUrl: "https://api.mistral.ai/v1",
      headers: { authorization: "Bearer mistral-key" },
      model: "mistral-embed",
    };
    createEmbeddingProviderMock.mockResolvedValueOnce({
      requestedProvider: "openai",
      provider: createProvider("openai"),
      openAi: openAiClient,
    } as EmbeddingProviderResult);
    createEmbeddingProviderMock.mockResolvedValueOnce({
      requestedProvider: "mistral",
      provider: createProvider("mistral"),
      mistral: mistralClient,
    } as EmbeddingProviderResult);

    const cfg = buildConfig({ workspaceDir, indexPath, provider: "openai", fallback: "mistral" });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    if (!result.manager) {
      throw new Error(`manager missing: ${result.error ?? "no error provided"}`);
    }
    manager = result.manager as unknown as MemoryIndexManager;
    await manager.probeEmbeddingAvailability();
    const internal = manager as unknown as {
      ensureProviderInitialized: () => Promise<void>;
      activateFallbackProvider: (reason: string) => Promise<boolean>;
      openAi?: OpenAiEmbeddingClient;
      mistral?: MistralEmbeddingClient;
    };

    await internal.ensureProviderInitialized();
    const activated = await internal.activateFallbackProvider("forced test");
    expect(activated).toBe(true);
    expect(internal.openAi).toBeUndefined();
    expect(internal.mistral).toBe(mistralClient);
  });

  it("uses default ollama model when activating ollama fallback", async () => {
    const openAiClient: OpenAiEmbeddingClient = {
      baseUrl: "https://api.openai.com/v1",
      headers: { authorization: "Bearer openai-key" },
      model: "text-embedding-3-small",
    };
    const ollamaClient: OllamaEmbeddingClient = {
      baseUrl: "http://127.0.0.1:11434",
      headers: {},
      model: DEFAULT_OLLAMA_EMBEDDING_MODEL,
      embedBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
    };
    createEmbeddingProviderMock.mockResolvedValueOnce({
      requestedProvider: "openai",
      provider: createProvider("openai"),
      openAi: openAiClient,
    } as EmbeddingProviderResult);
    createEmbeddingProviderMock.mockResolvedValueOnce({
      requestedProvider: "ollama",
      provider: createProvider("ollama"),
      ollama: ollamaClient,
    } as EmbeddingProviderResult);

    const cfg = buildConfig({ workspaceDir, indexPath, provider: "openai", fallback: "ollama" });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    if (!result.manager) {
      throw new Error(`manager missing: ${result.error ?? "no error provided"}`);
    }
    manager = result.manager as unknown as MemoryIndexManager;
    await manager.probeEmbeddingAvailability();
    const internal = manager as unknown as {
      ensureProviderInitialized: () => Promise<void>;
      activateFallbackProvider: (reason: string) => Promise<boolean>;
      openAi?: OpenAiEmbeddingClient;
      ollama?: OllamaEmbeddingClient;
    };

    await internal.ensureProviderInitialized();
    const activated = await internal.activateFallbackProvider("forced ollama fallback");
    expect(activated).toBe(true);
    expect(internal.openAi).toBeUndefined();
    expect(internal.ollama).toBe(ollamaClient);

    const fallbackCall = createEmbeddingProviderMock.mock.calls[1]?.[0] as
      | { provider?: string; model?: string }
      | undefined;
    expect(fallbackCall?.provider).toBe("ollama");
    expect(fallbackCall?.model).toBe(DEFAULT_OLLAMA_EMBEDDING_MODEL);
  });
});
