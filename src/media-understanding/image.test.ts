import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  completeMock: vi.fn(),
  ensureOpenClawModelsJsonMock: vi.fn(async () => {}),
  getApiKeyForModelMock: vi.fn(async () => ({
    apiKey: "oauth-test", // pragma: allowlist secret
    source: "test",
    mode: "oauth",
  })),
  resolveApiKeyForProviderMock: vi.fn(async () => ({
    apiKey: "oauth-test", // pragma: allowlist secret
    source: "test",
    mode: "oauth",
  })),
  requireApiKeyMock: vi.fn((auth: { apiKey?: string }) => auth.apiKey ?? ""),
  setRuntimeApiKeyMock: vi.fn(),
  discoverModelsMock: vi.fn(),
  resolveModelWithRegistryMock: vi.fn(),
  fetchMock: vi.fn(),
}));
const {
  completeMock,
  ensureOpenClawModelsJsonMock,
  getApiKeyForModelMock,
  resolveApiKeyForProviderMock,
  requireApiKeyMock,
  setRuntimeApiKeyMock,
  discoverModelsMock,
  resolveModelWithRegistryMock,
  fetchMock,
} = hoisted;

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
  return {
    ...actual,
    complete: completeMock,
  };
});

vi.mock("../agents/models-config.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/models-config.js")>(
    "../agents/models-config.js",
  )),
  ensureOpenClawModelsJson: ensureOpenClawModelsJsonMock,
}));

vi.mock("../agents/model-auth.js", () => ({
  getApiKeyForModel: getApiKeyForModelMock,
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
  requireApiKey: requireApiKeyMock,
}));

vi.mock("../agents/pi-model-discovery-runtime.js", () => ({
  discoverAuthStorage: () => ({
    setRuntimeApiKey: setRuntimeApiKeyMock,
  }),
  discoverModels: discoverModelsMock,
}));

vi.mock("../agents/pi-embedded-runner/model.js", () => ({
  resolveModelWithRegistry: resolveModelWithRegistryMock,
}));

const { describeImageWithModel } = await import("./image.js");

describe("describeImageWithModel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: vi.fn(() => null) },
      json: vi.fn(async () => ({
        base_resp: { status_code: 0 },
        content: "portal ok",
      })),
      text: vi.fn(async () => ""),
    });
    discoverModelsMock.mockReturnValue({ find: vi.fn(() => null) });
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "minimax-portal",
      id: "MiniMax-VL-01",
      input: ["text", "image"],
      baseUrl: "https://api.minimax.io/anthropic",
    });
  });

  it("routes minimax-portal image models through the MiniMax VLM endpoint", async () => {
    const authStore = { version: 1, profiles: {} };
    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "minimax-portal",
      model: "MiniMax-VL-01",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
      authStore,
    });

    expect(result).toEqual({
      text: "portal ok",
      model: "MiniMax-VL-01",
    });
    expect(ensureOpenClawModelsJsonMock).toHaveBeenCalled();
    expect(getApiKeyForModelMock).toHaveBeenCalledWith(
      expect.objectContaining({ store: authStore }),
    );
    expect(requireApiKeyMock).toHaveBeenCalled();
    expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("minimax-portal", "oauth-test");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.minimax.io/v1/coding_plan/vlm",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer oauth-test",
          "Content-Type": "application/json",
          "MM-API-Source": "OpenClaw",
        },
        body: JSON.stringify({
          prompt: "Describe the image.",
          image_url: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`,
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("uses generic completion for non-canonical minimax-portal image models", async () => {
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "minimax-portal",
      id: "custom-vision",
      input: ["text", "image"],
      baseUrl: "https://api.minimax.io/anthropic",
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "anthropic-messages",
      provider: "minimax-portal",
      model: "custom-vision",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "generic ok" }],
    });

    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "minimax-portal",
      model: "custom-vision",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "generic ok",
      model: "custom-vision",
    });
    expect(completeMock).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes image prompt as system instructions for codex image requests", async () => {
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "openai-codex",
      id: "gpt-5.4",
      input: ["text", "image"],
      baseUrl: "https://chatgpt.com/backend-api",
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.4",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "codex ok" }],
    });

    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "openai-codex",
      model: "gpt-5.4",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "codex ok",
      model: "gpt-5.4",
    });
    expect(completeMock).toHaveBeenCalledOnce();
    expect(completeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai-codex",
        id: "gpt-5.4",
      }),
      expect.objectContaining({
        systemPrompt: "Describe the image.",
        messages: [
          expect.objectContaining({
            role: "user",
            content: [
              expect.objectContaining({
                type: "image",
                mimeType: "image/png",
              }),
            ],
          }),
        ],
      }),
      expect.any(Object),
    );
    const [, context] = completeMock.mock.calls[0] ?? [];
    expect(context?.messages?.[0]?.content).toHaveLength(1);
  });

  it.each([
    {
      name: "direct OpenAI Responses baseUrl",
      provider: "openai",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4-mini",
        input: ["text", "image"],
        baseUrl: "https://api.openai.com/v1",
      },
      expectedRetryPayload: {
        reasoning: { effort: "none" },
      },
    },
    {
      name: "default OpenAI Responses route without explicit baseUrl",
      provider: "openai",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4-mini",
        input: ["text", "image"],
      },
      expectedRetryPayload: {
        reasoning: { effort: "none" },
      },
    },
    {
      name: "azure-openai provider using openai-responses api",
      provider: "azure-openai",
      model: {
        api: "openai-responses",
        provider: "azure-openai",
        id: "gpt-5.4-mini",
        input: ["text", "image"],
        baseUrl: "https://myresource.openai.azure.com/openai/v1",
      },
      expectedRetryPayload: {
        reasoning: { effort: "none" },
      },
    },
    {
      name: "proxy-like openai-responses route",
      provider: "openai",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4-mini",
        input: ["text", "image"],
        baseUrl: "https://proxy.example.com/v1",
      },
      expectedRetryPayload: {},
    },
  ])(
    "retries reasoning-only image responses with reasoning disabled for $name",
    async ({ provider, model, expectedRetryPayload }) => {
      discoverModelsMock.mockReturnValue({
        find: vi.fn(() => model),
      });
      resolveModelWithRegistryMock.mockReturnValue(model);
      completeMock
        .mockResolvedValueOnce({
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: "stop",
          timestamp: Date.now(),
          content: [
            {
              type: "thinking",
              thinking: "internal image reasoning",
              thinkingSignature: "reasoning_content",
            },
          ],
        })
        .mockResolvedValueOnce({
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: "stop",
          timestamp: Date.now(),
          content: [{ type: "text", text: "retry ok" }],
        });

      const result = await describeImageWithModel({
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        provider,
        model: model.id,
        buffer: Buffer.from("png-bytes"),
        fileName: "image.png",
        mime: "image/png",
        prompt: "Describe the image.",
        timeoutMs: 1000,
      });

      expect(result).toEqual({
        text: "retry ok",
        model: model.id,
      });
      expect(completeMock).toHaveBeenCalledTimes(2);
      const [, , retryOptions] = completeMock.mock.calls[1] ?? [];
      expect(retryOptions?.onPayload).toEqual(expect.any(Function));
      const retryPayload = await retryOptions?.onPayload?.(
        {
          reasoning: { effort: "high", summary: "auto" },
          reasoning_effort: "high",
          include: ["reasoning.encrypted_content"],
        },
        completeMock.mock.calls[1]?.[0],
      );
      expect(retryPayload).toEqual(expectedRetryPayload);
    },
  );

  it("normalizes deprecated google flash ids before lookup and keeps profile auth selection", async () => {
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "google",
      id: "gemini-3-flash-preview",
      input: ["text", "image"],
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "google-generative-ai",
      provider: "google",
      model: "gemini-3-flash-preview",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "flash ok" }],
    });

    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "google",
      model: "gemini-3.1-flash-preview",
      profile: "google:default",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "flash ok",
      model: "gemini-3-flash-preview",
    });
    expect(resolveModelWithRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "google", modelId: "gemini-3-flash-preview" }),
    );
    expect(getApiKeyForModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "google:default",
      }),
    );
    expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("google", "oauth-test");
  });

  it("normalizes gemini 3.1 flash-lite ids before lookup and keeps profile auth selection", async () => {
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "google",
      id: "gemini-3.1-flash-lite-preview",
      input: ["text", "image"],
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "google-generative-ai",
      provider: "google",
      model: "gemini-3.1-flash-lite-preview",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "flash lite ok" }],
    });

    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "google",
      model: "gemini-3.1-flash-lite",
      profile: "google:default",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "flash lite ok",
      model: "gemini-3.1-flash-lite-preview",
    });
    expect(resolveModelWithRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "google", modelId: "gemini-3.1-flash-lite-preview" }),
    );
    expect(getApiKeyForModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "google:default",
      }),
    );
    expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("google", "oauth-test");
  });

  it("resolves custom provider image models via config fallback when not in registry (#33185)", async () => {
    // Simulate resolveModelWithRegistry returning an ad-hoc model with input: ["text"]
    // (the default when model ID matching fails due to provider-prefixed IDs).
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "vllm",
      id: "Qwen3.5",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1234/v1",
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 8192,
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-completions",
      provider: "vllm",
      model: "Qwen3.5",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "custom vision ok" }],
    });

    const cfg = {
      models: {
        providers: {
          vllm: {
            baseUrl: "http://127.0.0.1:1234/v1",
            apiKey: "vllm-local", // pragma: allowlist secret
            api: "openai-completions" as const,
            models: [
              {
                id: "vllm/Qwen3.5",
                name: "Qwen3.5",
                reasoning: false,
                input: ["image", "text"] as Array<"text" | "image">,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    };

    const result = await describeImageWithModel({
      cfg,
      agentDir: "/tmp/openclaw-agent",
      provider: "vllm",
      model: "Qwen3.5",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "custom vision ok",
      model: "Qwen3.5",
    });
    expect(resolveModelWithRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "vllm",
        modelId: "Qwen3.5",
      }),
    );
    expect(completeMock).toHaveBeenCalledOnce();
  });

  it("prefers exact provider alias over normalized lookup for config fallback (#33185)", async () => {
    // When provider is "nvidia-api", resolvedRef.provider normalizes to "nvidia".
    // If the config contains both "nvidia" and "nvidia-api" entries, the exact
    // params.provider key must be used so the nvidia-api/<model> definition is
    // found rather than falling into the "nvidia" block.
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "nvidia",
      id: "meta-llama",
      api: "openai-completions",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 4096,
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-completions",
      provider: "nvidia",
      model: "meta-llama",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "nvidia vision ok" }],
    });

    const cfg = {
      models: {
        providers: {
          nvidia: {
            baseUrl: "https://integrate.api.nvidia.com/v1",
            apiKey: "nvidia-key", // pragma: allowlist secret
            api: "openai-completions" as const,
            models: [],
          },
          "nvidia-api": {
            baseUrl: "https://integrate.api.nvidia.com/v1",
            apiKey: "nvidia-key", // pragma: allowlist secret
            api: "openai-completions" as const,
            models: [
              {
                id: "nvidia-api/meta-llama",
                name: "meta-llama",
                reasoning: false,
                input: ["image", "text"] as Array<"text" | "image">,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
    };

    const result = await describeImageWithModel({
      cfg,
      agentDir: "/tmp/openclaw-agent",
      provider: "nvidia-api",
      model: "meta-llama",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "nvidia vision ok",
      model: "meta-llama",
    });
    expect(completeMock).toHaveBeenCalledOnce();
  });

  it("throws Unknown model when custom provider model is not resolvable at all (#33185)", async () => {
    resolveModelWithRegistryMock.mockReturnValue(undefined);

    await expect(
      describeImageWithModel({
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        provider: "nonexistent",
        model: "fake-model",
        buffer: Buffer.from("png-bytes"),
        fileName: "image.png",
        mime: "image/png",
        prompt: "Describe the image.",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("Unknown model: nonexistent/fake-model");
  });
});
