import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../../agents/auth-profiles/store.js";
import { QWEN_OAUTH_MARKER } from "../../agents/model-auth-markers.js";
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

vi.mock("openclaw/plugin-sdk/core", async () => {
  const actual = await vi.importActual<object>("openclaw/plugin-sdk/core");
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
                models: [{ id: "llama3.2", name: "llama3.2" }],
              },
            },
          },
        },
        env: {} as NodeJS.ProcessEnv,
        resolveProviderApiKey: () => ({ apiKey: undefined }),
      }),
    ).resolves.toEqual({
      provider: {
        baseUrl: "http://ollama-host:11434",
        api: "ollama",
        apiKey: "ollama-local",
        models: [{ id: "llama3.2", name: "llama3.2" }],
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
});
