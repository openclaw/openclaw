import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { makePrompter } from "./onboarding/__tests__/test-utils.js";
import { promptAndConfigureVllm } from "./vllm-setup.js";

const ensureAuthProfileStore = vi.hoisted(() => vi.fn());
const listProfilesForProvider = vi.hoisted(() => vi.fn());
const resolveApiKeyForProfile = vi.hoisted(() => vi.fn());
const upsertAuthProfileWithLock = vi.hoisted(() => vi.fn(async () => null));
const updateAuthProfileStoreWithLock = vi.hoisted(() => vi.fn(async () => null));
const buildVllmProvider = vi.hoisted(() => vi.fn());

vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveApiKeyForProfile,
  upsertAuthProfileWithLock,
}));

vi.mock("../agents/auth-profiles/store.js", () => ({
  updateAuthProfileStoreWithLock,
}));

vi.mock("../agents/models-config.providers.discovery.js", () => ({
  buildVllmProvider,
}));

function makeModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

describe("promptAndConfigureVllm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureAuthProfileStore.mockReturnValue({ version: 1, profiles: {} });
    listProfilesForProvider.mockImplementation(
      (store: { profiles: Record<string, { provider: string }> }, provider: string) =>
        Object.entries(store.profiles)
          .filter(([, credential]) => credential.provider === provider)
          .map(([profileId]) => profileId),
    );
    resolveApiKeyForProfile.mockResolvedValue({
      apiKey: "stored-vllm-key", // pragma: allowlist secret
      provider: "vllm",
    });
    buildVllmProvider.mockResolvedValue({
      baseUrl: "http://127.0.0.1:8000/v1",
      api: "openai-completions",
      models: [],
    });
  });

  it("reuses the previously configured base URL when updating an endpoint", async () => {
    ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "vllm:default": {
          type: "api_key",
          provider: "vllm",
          key: "stored-vllm-key", // pragma: allowlist secret
          metadata: { kind: "vllm", baseUrl: "http://gpu-box:8000/v1" },
        },
      },
    });
    buildVllmProvider.mockResolvedValue({
      baseUrl: "http://gpu-box:8000/v1",
      api: "openai-completions",
      models: [makeModel("meta-llama/Meta-Llama-3-8B-Instruct")],
    });

    const select = vi
      .fn()
      .mockResolvedValueOnce("__manage_endpoint__")
      .mockResolvedValueOnce("vllm")
      .mockResolvedValueOnce("__endpoint_update__");
    const text = vi.fn().mockResolvedValueOnce("http://gpu-box:8000/v1").mockResolvedValueOnce("");
    const multiselect = vi.fn().mockResolvedValue(["meta-llama/Meta-Llama-3-8B-Instruct"]);
    const prompter = makePrompter({ select, text: text as never, multiselect });
    const config = {
      models: {
        providers: {
          vllm: {
            baseUrl: "http://gpu-box:8000/v1",
            api: "openai-completions",
            models: [makeModel("meta-llama/Meta-Llama-3-8B-Instruct")],
          },
        },
      },
    } as OpenClawConfig;

    const result = await promptAndConfigureVllm({
      cfg: config,
      prompter,
      agentDir: "/tmp/openclaw-agent",
    });

    expect(result).not.toBeNull();
    if (!result) {
      throw new Error("Expected a configured vLLM result");
    }
    expect(text.mock.calls[0]?.[0]?.initialValue).toBe("http://gpu-box:8000/v1");
    expect(result.modelRef).toBe("vllm/meta-llama/Meta-Llama-3-8B-Instruct");
  });

  it("discovers models from the configured endpoint and lets the user choose multiple models", async () => {
    buildVllmProvider.mockResolvedValue({
      baseUrl: "http://127.0.0.1:8000/v1",
      api: "openai-completions",
      models: [makeModel("model-a"), makeModel("model-b")],
    });

    const select = vi.fn().mockResolvedValueOnce("model-b");
    const text = vi
      .fn()
      .mockResolvedValueOnce("http://127.0.0.1:8000/v1")
      .mockResolvedValueOnce("sk-vllm-test"); // pragma: allowlist secret
    const multiselect = vi.fn().mockResolvedValue(["model-a", "model-b"]);
    const prompter = makePrompter({ select, text: text as never, multiselect });

    const result = await promptAndConfigureVllm({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
      prompter,
      agentDir: "/tmp/openclaw-agent",
    });

    expect(result).not.toBeNull();
    if (!result) {
      throw new Error("Expected a configured vLLM result");
    }
    expect(buildVllmProvider).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "sk-vllm-test", // pragma: allowlist secret
    });
    expect(result.modelRef).toBe("vllm/model-b");
    expect(result.config.models?.providers?.vllm?.models).toEqual([
      expect.objectContaining({ id: "model-a" }),
      expect.objectContaining({ id: "model-b" }),
    ]);
  });

  it("supports adding a second vLLM endpoint with a new provider key", async () => {
    ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "vllm:default": {
          type: "api_key",
          provider: "vllm",
          key: "stored-vllm-key", // pragma: allowlist secret
          metadata: { kind: "vllm", baseUrl: "http://gpu-a:8000/v1" },
        },
      },
    });
    buildVllmProvider.mockResolvedValue({
      baseUrl: "http://gpu-b:8000/v1",
      api: "openai-completions",
      models: [makeModel("model-c")],
    });

    const select = vi.fn().mockResolvedValueOnce("__add_endpoint__");
    const text = vi
      .fn()
      .mockResolvedValueOnce("http://gpu-b:8000/v1")
      .mockResolvedValueOnce("sk-vllm-b"); // pragma: allowlist secret
    const multiselect = vi.fn().mockResolvedValue(["model-c"]);
    const prompter = makePrompter({ select, text: text as never, multiselect });
    const config = {
      models: {
        providers: {
          vllm: {
            baseUrl: "http://gpu-a:8000/v1",
            api: "openai-completions",
            models: [makeModel("model-a")],
          },
        },
      },
    } as OpenClawConfig;

    const result = await promptAndConfigureVllm({
      cfg: config,
      prompter,
      agentDir: "/tmp/openclaw-agent",
    });

    expect(result).not.toBeNull();
    if (!result) {
      throw new Error("Expected a configured vLLM result");
    }
    expect(result.modelRef).toBe("vllm-2/model-c");
    expect(result.config.models?.providers?.vllm).toBeDefined();
    expect(result.config.models?.providers?.["vllm-2"]).toMatchObject({
      baseUrl: "http://gpu-b:8000/v1",
      models: [expect.objectContaining({ id: "model-c" })],
    });
    expect(upsertAuthProfileWithLock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "vllm-2:default",
        credential: expect.objectContaining({ provider: "vllm-2" }),
      }),
    );
  });

  it("lets the user exit after deleting the last vLLM endpoint", async () => {
    ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "vllm:default": {
          type: "api_key",
          provider: "vllm",
          key: "stored-vllm-key", // pragma: allowlist secret
          metadata: { kind: "vllm", baseUrl: "http://gpu-a:8000/v1" },
        },
      },
    });

    const select = vi
      .fn()
      .mockResolvedValueOnce("__manage_endpoint__")
      .mockResolvedValueOnce("vllm")
      .mockResolvedValueOnce("__endpoint_delete__")
      .mockResolvedValueOnce("__done__");
    const confirm = vi.fn().mockResolvedValue(true);
    const prompter = makePrompter({ select, confirm });
    const config = {
      models: {
        providers: {
          vllm: {
            baseUrl: "http://gpu-a:8000/v1",
            api: "openai-completions",
            models: [makeModel("model-a")],
          },
        },
      },
    } as OpenClawConfig;

    const result = await promptAndConfigureVllm({
      cfg: config,
      prompter,
      agentDir: "/tmp/openclaw-agent",
    });

    expect(result).toBeNull();
    expect(updateAuthProfileStoreWithLock).toHaveBeenCalled();
  });
});
