import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../../agents/auth-profiles/store.js";
import { QWEN_OAUTH_MARKER } from "../../agents/model-auth-markers.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import { createCapturedPluginRegistration } from "../../test-utils/plugin-registration.js";
import { runProviderCatalog } from "../provider-discovery.js";
import type { OpenClawPluginApi, ProviderPlugin } from "../types.js";

const resolveCopilotApiTokenMock = vi.hoisted(() => vi.fn());
const buildOllamaProviderMock = vi.hoisted(() => vi.fn());
const buildVllmProviderMock = vi.hoisted(() => vi.fn());
const buildSglangProviderMock = vi.hoisted(() => vi.fn());

vi.mock("../../../extensions/github-copilot/token.js", async () => {
  const actual = await vi.importActual<object>("../../../extensions/github-copilot/token.js");
  return {
    ...actual,
    resolveCopilotApiToken: resolveCopilotApiTokenMock,
  };
});

vi.mock("openclaw/plugin-sdk/provider-setup", async () => {
  const actual = await vi.importActual<object>("openclaw/plugin-sdk/provider-setup");
  return {
    ...actual,
    buildOllamaProvider: (...args: unknown[]) => buildOllamaProviderMock(...args),
    buildVllmProvider: (...args: unknown[]) => buildVllmProviderMock(...args),
    buildSglangProvider: (...args: unknown[]) => buildSglangProviderMock(...args),
  };
});

const qwenPortalPlugin = (await import("../../../extensions/qwen-portal-auth/index.js")).default;
const githubCopilotPlugin = (await import("../../../extensions/github-copilot/index.js")).default;
const ollamaPlugin = (await import("../../../extensions/ollama/index.js")).default;
const vllmPlugin = (await import("../../../extensions/vllm/index.js")).default;
const sglangPlugin = (await import("../../../extensions/sglang/index.js")).default;
const minimaxPlugin = (await import("../../../extensions/minimax/index.js")).default;
const modelStudioPlugin = (await import("../../../extensions/modelstudio/index.js")).default;
const cloudflareAiGatewayPlugin = (
  await import("../../../extensions/cloudflare-ai-gateway/index.js")
).default;

function registerProviders(...plugins: Array<{ register(api: OpenClawPluginApi): void }>) {
  const captured = createCapturedPluginRegistration();
  for (const plugin of plugins) {
    plugin.register(captured.api);
  }
  return captured.providers;
}

function requireProvider(providers: ProviderPlugin[], providerId: string) {
  const provider = providers.find((entry) => entry.id === providerId);
  if (!provider) {
    throw new Error(`provider ${providerId} missing`);
  }
  return provider;
}

function createModelConfig(id: string, name = id): ModelDefinitionConfig {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}
describe("provider discovery contract", () => {
  afterEach(() => {
    resolveCopilotApiTokenMock.mockReset();
    buildOllamaProviderMock.mockReset();
    buildVllmProviderMock.mockReset();
    buildSglangProviderMock.mockReset();
    clearRuntimeAuthProfileStoreSnapshots();
  });

  it("keeps qwen portal oauth marker fallback provider-owned", async () => {
    const provider = requireProvider(registerProviders(qwenPortalPlugin), "qwen-portal");
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        store: {
          version: 1,
          profiles: {
            "qwen-portal:default": {
              type: "oauth",
              provider: "qwen-portal",
              access: "access-token",
              refresh: "refresh-token",
              expires: Date.now() + 60_000,
            },
          },
        },
      },
    ]);

    await expect(
      runProviderCatalog({
        provider,
        config: {},
        env: {} as NodeJS.ProcessEnv,
        resolveProviderApiKey: () => ({ apiKey: undefined }),
      }),
    ).resolves.toEqual({
      provider: {
        baseUrl: "https://portal.qwen.ai/v1",
        apiKey: QWEN_OAUTH_MARKER,
        api: "openai-completions",
        models: [
          expect.objectContaining({ id: "coder-model", name: "Qwen Coder" }),
          expect.objectContaining({ id: "vision-model", name: "Qwen Vision" }),
        ],
      },
    });
  });

  it("keeps qwen portal env api keys higher priority than oauth markers", async () => {
    const provider = requireProvider(registerProviders(qwenPortalPlugin), "qwen-portal");
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        store: {
          version: 1,
          profiles: {
            "qwen-portal:default": {
              type: "oauth",
              provider: "qwen-portal",
              access: "access-token",
              refresh: "refresh-token",
              expires: Date.now() + 60_000,
            },
          },
        },
      },
    ]);

    await expect(
      runProviderCatalog({
        provider,
        config: {},
        env: { QWEN_PORTAL_API_KEY: "env-key" } as NodeJS.ProcessEnv,
        resolveProviderApiKey: () => ({ apiKey: "env-key" }),
      }),
    ).resolves.toMatchObject({
      provider: {
        apiKey: "env-key",
      },
    });
  });

  it("keeps GitHub Copilot catalog disabled without env tokens or profiles", async () => {
    const provider = requireProvider(registerProviders(githubCopilotPlugin), "github-copilot");

    await expect(
      runProviderCatalog({
        provider,
        config: {},
        env: {} as NodeJS.ProcessEnv,
        resolveProviderApiKey: () => ({ apiKey: undefined }),
      }),
    ).resolves.toBeNull();
  });

  it("keeps GitHub Copilot profile-only catalog fallback provider-owned", async () => {
    const provider = requireProvider(registerProviders(githubCopilotPlugin), "github-copilot");
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        store: {
          version: 1,
          profiles: {
            "github-copilot:github": {
              type: "token",
              provider: "github-copilot",
              token: "profile-token",
            },
          },
        },
      },
    ]);

    await expect(
      runProviderCatalog({
        provider,
        config: {},
        env: {} as NodeJS.ProcessEnv,
        resolveProviderApiKey: () => ({ apiKey: undefined }),
      }),
    ).resolves.toEqual({
      provider: {
        baseUrl: "https://api.individual.githubcopilot.com",
        models: [],
      },
    });
  });

  it("keeps GitHub Copilot env-token base URL resolution provider-owned", async () => {
    const provider = requireProvider(registerProviders(githubCopilotPlugin), "github-copilot");
    resolveCopilotApiTokenMock.mockResolvedValueOnce({
      token: "copilot-api-token",
      baseUrl: "https://copilot-proxy.example.com",
      expiresAt: Date.now() + 60_000,
    });

    await expect(
      runProviderCatalog({
        provider,
        config: {},
        env: {
          GITHUB_TOKEN: "github-env-token",
        } as NodeJS.ProcessEnv,
        resolveProviderApiKey: () => ({ apiKey: undefined }),
      }),
    ).resolves.toEqual({
      provider: {
        baseUrl: "https://copilot-proxy.example.com",
        models: [],
      },
    });
    expect(resolveCopilotApiTokenMock).toHaveBeenCalledWith({
      githubToken: "github-env-token",
      env: expect.objectContaining({
        GITHUB_TOKEN: "github-env-token",
      }),
    });
  });

  it("keeps Ollama explicit catalog normalization provider-owned", async () => {
    const provider = requireProvider(registerProviders(ollamaPlugin), "ollama");

    await expect(
      runProviderCatalog({
        provider,
        config: {
          models: {
            providers: {
              ollama: {
                baseUrl: "http://ollama-host:11434/v1/",
                models: [createModelConfig("llama3.2")],
              },
            },
          },
        },
        env: {} as NodeJS.ProcessEnv,
        resolveProviderApiKey: () => ({ apiKey: undefined }),
      }),
    ).resolves.toMatchObject({
      provider: {
        baseUrl: "http://ollama-host:11434",
        api: "ollama",
        apiKey: "ollama-local",
        models: [createModelConfig("llama3.2")],
      },
    });
    expect(buildOllamaProviderMock).not.toHaveBeenCalled();
  });

  it("keeps Ollama empty autodiscovery disabled without keys or explicit config", async () => {
    const provider = requireProvider(registerProviders(ollamaPlugin), "ollama");
    buildOllamaProviderMock.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:11434",
      api: "ollama",
      models: [],
    });

    await expect(
      runProviderCatalog({
        provider,
        config: {},
        env: {} as NodeJS.ProcessEnv,
        resolveProviderApiKey: () => ({ apiKey: undefined }),
      }),
    ).resolves.toBeNull();
    expect(buildOllamaProviderMock).toHaveBeenCalledWith(undefined, { quiet: true });
  });

  it("keeps vLLM self-hosted discovery provider-owned", async () => {
    const provider = requireProvider(registerProviders(vllmPlugin), "vllm");
    buildVllmProviderMock.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:8000/v1",
      api: "openai-completions",
      models: [{ id: "meta-llama/Meta-Llama-3-8B-Instruct", name: "Meta Llama 3" }],
    });

    await expect(
      runProviderCatalog({
        provider,
        config: {},
        env: {
          VLLM_API_KEY: "env-vllm-key",
        } as NodeJS.ProcessEnv,
        resolveProviderApiKey: () => ({
          apiKey: "VLLM_API_KEY",
          discoveryApiKey: "env-vllm-key",
        }),
      }),
    ).resolves.toEqual({
      provider: {
        baseUrl: "http://127.0.0.1:8000/v1",
        api: "openai-completions",
        apiKey: "VLLM_API_KEY",
        models: [{ id: "meta-llama/Meta-Llama-3-8B-Instruct", name: "Meta Llama 3" }],
      },
    });
    expect(buildVllmProviderMock).toHaveBeenCalledWith({
      apiKey: "env-vllm-key",
    });
  });

  it("keeps SGLang self-hosted discovery provider-owned", async () => {
    const provider = requireProvider(registerProviders(sglangPlugin), "sglang");
    buildSglangProviderMock.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:30000/v1",
      api: "openai-completions",
      models: [{ id: "Qwen/Qwen3-8B", name: "Qwen3-8B" }],
    });

    await expect(
      runProviderCatalog({
        provider,
        config: {},
        env: {
          SGLANG_API_KEY: "env-sglang-key",
        } as NodeJS.ProcessEnv,
        resolveProviderApiKey: () => ({
          apiKey: "SGLANG_API_KEY",
          discoveryApiKey: "env-sglang-key",
        }),
      }),
    ).resolves.toEqual({
      provider: {
        baseUrl: "http://127.0.0.1:30000/v1",
        api: "openai-completions",
        apiKey: "SGLANG_API_KEY",
        models: [{ id: "Qwen/Qwen3-8B", name: "Qwen3-8B" }],
      },
    });
    expect(buildSglangProviderMock).toHaveBeenCalledWith({
      apiKey: "env-sglang-key",
    });
  });

  it("keeps MiniMax API catalog provider-owned", async () => {
    const provider = requireProvider(registerProviders(minimaxPlugin), "minimax");

    await expect(
      runProviderCatalog({
        provider,
        config: {},
        env: {
          MINIMAX_API_KEY: "minimax-key",
        } as NodeJS.ProcessEnv,
        resolveProviderApiKey: () => ({ apiKey: "minimax-key" }),
      }),
    ).resolves.toMatchObject({
      provider: {
        baseUrl: "https://api.minimax.io/anthropic",
        api: "anthropic-messages",
        authHeader: true,
        apiKey: "minimax-key",
        models: expect.arrayContaining([
          expect.objectContaining({ id: "MiniMax-M2.5" }),
          expect.objectContaining({ id: "MiniMax-VL-01" }),
        ]),
      },
    });
  });

  it("keeps MiniMax portal oauth marker fallback provider-owned", async () => {
    const provider = requireProvider(registerProviders(minimaxPlugin), "minimax-portal");
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        store: {
          version: 1,
          profiles: {
            "minimax-portal:default": {
              type: "oauth",
              provider: "minimax-portal",
              access: "access-token",
              refresh: "refresh-token",
              expires: Date.now() + 60_000,
            },
          },
        },
      },
    ]);

    await expect(
      runProviderCatalog({
        provider,
        config: {},
        env: {} as NodeJS.ProcessEnv,
        resolveProviderApiKey: () => ({ apiKey: undefined }),
      }),
    ).resolves.toMatchObject({
      provider: {
        baseUrl: "https://api.minimax.io/anthropic",
        api: "anthropic-messages",
        authHeader: true,
        apiKey: "minimax-oauth",
        models: expect.arrayContaining([expect.objectContaining({ id: "MiniMax-M2.5" })]),
      },
    });
  });

  it("keeps MiniMax portal explicit base URL override provider-owned", async () => {
    const provider = requireProvider(registerProviders(minimaxPlugin), "minimax-portal");

    await expect(
      runProviderCatalog({
        provider,
        config: {
          models: {
            providers: {
              "minimax-portal": {
                baseUrl: "https://portal-proxy.example.com/anthropic",
                apiKey: "explicit-key",
                models: [],
              },
            },
          },
        },
        env: {} as NodeJS.ProcessEnv,
        resolveProviderApiKey: () => ({ apiKey: undefined }),
      }),
    ).resolves.toMatchObject({
      provider: {
        baseUrl: "https://portal-proxy.example.com/anthropic",
        apiKey: "explicit-key",
      },
    });
  });

  it("keeps Model Studio catalog provider-owned", async () => {
    const provider = requireProvider(registerProviders(modelStudioPlugin), "modelstudio");

    await expect(
      runProviderCatalog({
        provider,
        config: {
          models: {
            providers: {
              modelstudio: {
                baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
                models: [],
              },
            },
          },
        },
        env: {
          MODELSTUDIO_API_KEY: "modelstudio-key",
        } as NodeJS.ProcessEnv,
        resolveProviderApiKey: () => ({ apiKey: "modelstudio-key" }),
      }),
    ).resolves.toMatchObject({
      provider: {
        baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
        api: "openai-completions",
        apiKey: "modelstudio-key",
        models: expect.arrayContaining([
          expect.objectContaining({ id: "qwen3.5-plus" }),
          expect.objectContaining({ id: "MiniMax-M2.5" }),
        ]),
      },
    });
  });

  it("keeps Cloudflare AI Gateway catalog disabled without stored metadata", async () => {
    const provider = requireProvider(
      registerProviders(cloudflareAiGatewayPlugin),
      "cloudflare-ai-gateway",
    );

    await expect(
      runProviderCatalog({
        provider,
        config: {},
        env: {} as NodeJS.ProcessEnv,
        resolveProviderApiKey: () => ({ apiKey: undefined }),
      }),
    ).resolves.toBeNull();
  });

  it("keeps Cloudflare AI Gateway env-managed catalog provider-owned", async () => {
    const provider = requireProvider(
      registerProviders(cloudflareAiGatewayPlugin),
      "cloudflare-ai-gateway",
    );
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        store: {
          version: 1,
          profiles: {
            "cloudflare-ai-gateway:default": {
              type: "api_key",
              provider: "cloudflare-ai-gateway",
              keyRef: {
                source: "env",
                provider: "default",
                id: "CLOUDFLARE_AI_GATEWAY_API_KEY",
              },
              metadata: {
                accountId: "acc-123",
                gatewayId: "gw-456",
              },
            },
          },
        },
      },
    ]);

    await expect(
      runProviderCatalog({
        provider,
        config: {},
        env: {
          CLOUDFLARE_AI_GATEWAY_API_KEY: "secret-value",
        } as NodeJS.ProcessEnv,
        resolveProviderApiKey: () => ({ apiKey: undefined }),
      }),
    ).resolves.toEqual({
      provider: {
        baseUrl: "https://gateway.ai.cloudflare.com/v1/acc-123/gw-456/anthropic",
        api: "anthropic-messages",
        apiKey: "CLOUDFLARE_AI_GATEWAY_API_KEY",
        models: [expect.objectContaining({ id: "claude-sonnet-4-5" })],
      },
    });
  });
});
