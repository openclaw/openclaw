// Runtime model preflight tests cover provider/model checks before cron execution.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock, resolveApiKeyForProviderMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
  resolveApiKeyForProviderMock: vi.fn(),
}));

vi.mock("../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("../../plugin-sdk/provider-auth-runtime.js", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

import {
  preflightCronModelProvider,
  resetCronModelProviderPreflightCacheForTest,
} from "./model-preflight.runtime.js";

function mockReachableResponse(status = 200) {
  fetchWithSsrFGuardMock.mockResolvedValueOnce({
    response: { status },
    release: vi.fn(async () => {}),
  });
}

function requireFetchPreflightRequest(): {
  url?: string;
  timeoutMs?: number;
  auditContext?: string;
  init?: { method?: string; headers?: Record<string, string> };
} {
  const request = fetchWithSsrFGuardMock.mock.calls[0]?.[0] as
    | { url?: string; timeoutMs?: number; auditContext?: string }
    | undefined;
  if (!request) {
    throw new Error("Expected cron model preflight fetch request");
  }
  return request;
}

describe("preflightCronModelProvider", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    resolveApiKeyForProviderMock.mockReset();
    resetCronModelProviderPreflightCacheForTest();
    // Default: resolveApiKeyForProvider returns an empty auth result (no apiKey)
    resolveApiKeyForProviderMock.mockResolvedValue({ mode: "api-key" });
  });

  // ── Existing tests (pre-PR, unmodified) ──

  it("skips network checks for cloud provider URLs", async () => {
    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
          },
        },
      },
      provider: "openai",
      model: "gpt-5.4",
    });

    expect(result).toEqual({ status: "available" });
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("treats any HTTP response from a local OpenAI-compatible endpoint as reachable", async () => {
    mockReachableResponse(401);

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            vllm: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8000/v1",
              models: [],
            },
          },
        },
      },
      provider: "vllm",
      model: "llama",
    });

    expect(result).toEqual({ status: "available" });
    const request = requireFetchPreflightRequest();
    expect(request.url).toBe("http://127.0.0.1:8000/v1/models");
    expect(request.timeoutMs).toBe(2500);
  });

  it("marks unreachable local Ollama endpoints unavailable and caches the result", async () => {
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const cfg = {
      models: {
        providers: {
          Ollama: {
            api: "ollama" as const,
            baseUrl: "http://localhost:11434",
            models: [],
          },
        },
      },
    };
    const first = await preflightCronModelProvider({
      cfg,
      provider: "ollama",
      model: "qwen3:32b",
      nowMs: 1000,
    });
    const second = await preflightCronModelProvider({
      cfg,
      provider: "ollama",
      model: "llama3.3:70b",
      nowMs: 2000,
    });

    expect(first.status).toBe("unavailable");
    if (first.status !== "unavailable") {
      throw new Error(`expected first preflight unavailable, got ${first.status}`);
    }
    expect(first.provider).toBe("ollama");
    expect(first.model).toBe("qwen3:32b");
    expect(first.baseUrl).toBe("http://localhost:11434");
    expect(first.retryAfterMs).toBe(300000);
    expect(second.status).toBe("unavailable");
    if (second.status !== "unavailable") {
      throw new Error(`expected second preflight unavailable, got ${second.status}`);
    }
    expect(second.provider).toBe("ollama");
    expect(second.model).toBe("llama3.3:70b");
    expect(second.baseUrl).toBe("http://localhost:11434");
    expect(second.retryAfterMs).toBe(300000);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    const request = requireFetchPreflightRequest();
    expect(request.url).toBe("http://localhost:11434/api/tags");
    expect(request.auditContext).toBe("cron-model-provider-preflight");
  });

  it("retries an unavailable endpoint after the cache ttl", async () => {
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("ECONNREFUSED")).mockResolvedValueOnce({
      response: { status: 200 },
      release: vi.fn(async () => {}),
    });

    const cfg = {
      models: {
        providers: {
          ollama: {
            api: "ollama" as const,
            baseUrl: "http://127.0.0.1:11434",
            models: [],
          },
        },
      },
    };

    const first = await preflightCronModelProvider({
      cfg,
      provider: "ollama",
      model: "llama3",
      nowMs: 1000,
    });
    const second = await preflightCronModelProvider({
      cfg,
      provider: "ollama",
      model: "llama3",
      nowMs: 1000 + 300001,
    });

    expect(first.status).toBe("unavailable");
    expect(second).toEqual({ status: "available" });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
  });

  // ── Auth resolution tests ──

  it("sends Authorization Bearer header when resolveApiKeyForProvider returns an apiKey", async () => {
    mockReachableResponse(200);
    resolveApiKeyForProviderMock.mockResolvedValueOnce({
      apiKey: "sk-xxx",
      mode: "api-key",
      source: "config",
    });

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            litellm: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:4000",
              models: [],
            },
          },
        },
      },
      provider: "litellm",
      model: "gpt-4",
    });

    expect(result).toEqual({ status: "available" });
    const request = requireFetchPreflightRequest();
    expect(request.init?.headers).toEqual({
      Authorization: "Bearer sk-xxx",
    });
  });

  it("does not send Authorization header when no apiKey is resolved", async () => {
    mockReachableResponse(200);
    // Default mock returns { mode: "api-key" } with no apiKey

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://localhost:11434",
              models: [],
            },
          },
        },
      },
      provider: "ollama",
      model: "llama3",
    });

    expect(result).toEqual({ status: "available" });
    const request = requireFetchPreflightRequest();
    expect(request.init?.headers).toBeUndefined();
  });

  it("does not send Authorization header when resolveApiKeyForProvider returns a non-secret marker", async () => {
    mockReachableResponse(200);
    resolveApiKeyForProviderMock.mockResolvedValueOnce({
      apiKey: "custom-local",
      mode: "api-key",
      source: "config",
    });

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://localhost:11434",
              models: [],
            },
          },
        },
      },
      provider: "ollama",
      model: "llama3",
    });

    expect(result).toEqual({ status: "available" });
    const request = requireFetchPreflightRequest();
    // Should NOT include Authorization header when apiKey is a marker
    expect(request.init?.headers).toBeUndefined();
  });

  it("skips Authorization header for OAuth credentials", async () => {
    mockReachableResponse(200);
    resolveApiKeyForProviderMock.mockResolvedValueOnce({
      apiKey: "oauth-token-123",
      mode: "oauth",
      source: "auth-profile",
    });

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            openai: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:4000",
              models: [],
            },
          },
        },
      },
      provider: "openai",
      model: "gpt-4",
    });

    expect(result).toEqual({ status: "available" });
    const request = requireFetchPreflightRequest();
    // OAuth tokens should not be sent in preflight probes
    expect(request.init?.headers).toBeUndefined();
  });

  it("handles resolveApiKeyForProvider rejection gracefully", async () => {
    mockReachableResponse(200);
    resolveApiKeyForProviderMock.mockRejectedValueOnce(new Error("No auth profiles found"));

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://localhost:11434",
              models: [],
            },
          },
        },
      },
      provider: "ollama",
      model: "llama3",
    });

    // Preflight should still succeed (no auth) even if auth resolution fails
    expect(result).toEqual({ status: "available" });
    const request = requireFetchPreflightRequest();
    expect(request.init?.headers).toBeUndefined();
  });

  it("uses request.auth.token over resolveApiKeyForProvider when mode is authorization-bearer", async () => {
    mockReachableResponse(200);
    // Set up resolveApiKeyForProvider to return a different key
    resolveApiKeyForProviderMock.mockResolvedValueOnce({
      apiKey: "should-not-be-used",
      mode: "api-key",
      source: "config",
    });

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            customllm: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8080",
              request: {
                auth: {
                  mode: "authorization-bearer",
                  token: "cfg-token-value",
                },
              },
              models: [],
            },
          },
        },
      },
      provider: "customllm",
      model: "my-model",
    });

    expect(result).toEqual({ status: "available" });
    // Verify that the auth.token is used, not the resolveApiKeyForProvider value
    expect(resolveApiKeyForProviderMock).not.toHaveBeenCalled();
    const request = requireFetchPreflightRequest();
    expect(request.init?.headers).toEqual({
      Authorization: "Bearer cfg-token-value",
    });
  });

  it("passes agentDir and workspaceDir to resolveApiKeyForProvider", async () => {
    mockReachableResponse(200);
    resolveApiKeyForProviderMock.mockResolvedValueOnce({
      apiKey: "sk-dir-test",
      mode: "api-key",
      source: "auth-profile",
    });

    await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            litellm: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:4000",
              models: [],
            },
          },
        },
      },
      provider: "litellm",
      model: "gpt-4",
      agentDir: "/custom/agent/path",
      workspaceDir: "/custom/workspace/path",
    });

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/custom/agent/path",
        workspaceDir: "/custom/workspace/path",
      }),
    );
  });

  it("redacts Authorization header from error messages in unavailable results", async () => {
    // Simulate a network error that includes auth header in the message
    fetchWithSsrFGuardMock.mockRejectedValueOnce(
      new Error("Request failed: Authorization: Bearer sk-test-secret-99999 at endpoint"),
    );

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            litellm: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:4000",
              models: [],
            },
          },
        },
      },
      provider: "litellm",
      model: "gpt-4",
      nowMs: 1000,
    });

    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") {
      throw new Error(`expected unavailable, got ${result.status}`);
    }
    expect(result.reason).toContain("[REDACTED]");
    expect(result.reason).not.toContain("sk-test-secret-99999");
  });

  it("caches preflight result independently of auth variations", async () => {
    // First call: endpoint is available with one auth
    mockReachableResponse(200);
    resolveApiKeyForProviderMock.mockResolvedValueOnce({
      apiKey: "sk-first-key",
      mode: "api-key",
      source: "config",
    });

    const cfg = {
      models: {
        providers: {
          myprovider: {
            api: "openai-completions" as const,
            baseUrl: "http://127.0.0.1:4000",
            models: [],
          },
        },
      },
    };

    const first = await preflightCronModelProvider({
      cfg,
      provider: "myprovider",
      model: "model-a",
      nowMs: 1000,
    });

    expect(first).toEqual({ status: "available" });

    // Second call: same endpoint (api\0baseUrl key), different provider/model
    // This should hit the cache and NOT call fetchWithSsrFGuard again
    const second = await preflightCronModelProvider({
      cfg,
      provider: "myprovider",
      model: "model-b",
      nowMs: 2000,
    });

    expect(second).toEqual({ status: "available" });
    // fetchWithSsrFGuard should only have been called once (first call only)
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
  });
});
