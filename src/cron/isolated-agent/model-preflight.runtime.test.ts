// Runtime model preflight tests cover provider/model checks before cron execution.
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetchWithSsrFGuardMock,
  resolveApiKeyForProviderMock,
  resolveProviderRequestHeadersMock,
  sanitizeConfiguredProviderRequestMock,
} = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
  resolveApiKeyForProviderMock: vi.fn(),
  resolveProviderRequestHeadersMock: vi.fn(),
  sanitizeConfiguredProviderRequestMock: vi.fn(),
}));

vi.mock("../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("../../plugin-sdk/provider-auth-runtime.js", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("../../agents/provider-request-config.js", () => ({
  resolveProviderRequestHeaders: resolveProviderRequestHeadersMock,
  sanitizeConfiguredProviderRequest: sanitizeConfiguredProviderRequestMock,
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
    resolveProviderRequestHeadersMock.mockReset();
    sanitizeConfiguredProviderRequestMock.mockReset();
    resetCronModelProviderPreflightCacheForTest();
    // Default: resolveApiKeyForProvider returns an empty auth result (no apiKey)
    resolveApiKeyForProviderMock.mockResolvedValue({ mode: "api-key" });

    // Default: sanitizeConfiguredProviderRequest replicates the real sanitization
    sanitizeConfiguredProviderRequestMock.mockImplementation((request: any) => {
      if (!request || typeof request !== "object" || Array.isArray(request)) {
        return undefined;
      }
      let hasContent = false;
      const result: any = {};
      if (
        request.headers &&
        typeof request.headers === "object" &&
        !Array.isArray(request.headers)
      ) {
        const sanitized: Record<string, string> = {};
        for (const [key, val] of Object.entries(request.headers)) {
          if (typeof val === "string") {
            sanitized[key] = val;
          }
        }
        if (Object.keys(sanitized).length > 0) {
          result.headers = sanitized;
          hasContent = true;
        }
      }
      if (request.auth) {
        const auth = request.auth;
        if (auth.mode === "provider-default") {
          result.auth = { mode: "provider-default" };
          hasContent = true;
        } else if (auth.mode === "authorization-bearer") {
          const token = typeof auth.token === "string" ? auth.token.trim() : "";
          if (token) {
            result.auth = { mode: "authorization-bearer", token };
            hasContent = true;
          }
        } else if (auth.mode === "header") {
          const headerName = typeof auth.headerName === "string" ? auth.headerName.trim() : "";
          const value = typeof auth.value === "string" ? auth.value.trim() : "";
          if (headerName && value) {
            const prefix = typeof auth.prefix === "string" ? auth.prefix.trim() : undefined;
            result.auth = {
              mode: "header",
              headerName,
              value,
              ...(prefix ? { prefix } : {}),
            };
            hasContent = true;
          }
        }
      }
      return hasContent ? result : undefined;
    });

    // Default: resolveProviderRequestHeaders builds headers from auth config
    // Merges request.headers, defaultHeaders, then auth on top.
    resolveProviderRequestHeadersMock.mockImplementation((params: any) => {
      const headers: Record<string, string> = {};
      if (params.request?.headers) {
        Object.assign(headers, params.request.headers);
      }
      if (params.defaultHeaders) {
        // defaultHeaders override request.headers for matching keys
        Object.assign(headers, params.defaultHeaders);
      }
      if (params.request?.auth) {
        const auth = params.request.auth;
        if (auth.mode === "authorization-bearer") {
          headers.Authorization = `Bearer ${auth.token}`;
        } else if (auth.mode === "header") {
          const prefix = auth.prefix ?? "";
          headers[auth.headerName] = `${prefix}${auth.value}`;
        }
      }
      return Object.keys(headers).length > 0 ? headers : undefined;
    });
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
    expect(result.reason).not.toContain("sk-test-secret-99999");
    // The error is redacted; last 4 chars preserved, first part replaced with ***...
    expect(result.reason).toContain("…9999");
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

  // ── header mode auth tests ──

  it("sends custom headers when request.auth.mode is header", async () => {
    mockReachableResponse(200);

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            mylocal: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8080",
              request: {
                auth: {
                  mode: "header",
                  headerName: "X-API-Key",
                  value: "my-secret-key",
                },
              },
              models: [],
            },
          },
        },
      },
      provider: "mylocal",
      model: "my-model",
    });

    expect(result).toEqual({ status: "available" });
    const request = requireFetchPreflightRequest();
    expect(request.init?.headers).toHaveProperty("X-API-Key", "my-secret-key");
  });

  it("includes prefix in header value when request.auth.mode is header with a prefix", async () => {
    mockReachableResponse(200);

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            mylocal: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8080",
              request: {
                auth: {
                  mode: "header",
                  headerName: "Authorization",
                  value: "my-custom-token",
                  prefix: "CustomBearer",
                },
              },
              models: [],
            },
          },
        },
      },
      provider: "mylocal",
      model: "my-model",
    });

    expect(result).toEqual({ status: "available" });
    const request = requireFetchPreflightRequest();
    expect(request.init?.headers).toHaveProperty("Authorization", "CustomBearermy-custom-token");
  });

  it("skips header mode auth when headerName is empty or whitespace-only", async () => {
    mockReachableResponse(200);

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            mylocal: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8080",
              request: {
                auth: {
                  mode: "header",
                  headerName: "   ",
                  value: "some-value",
                },
              },
              models: [],
            },
          },
        },
      },
      provider: "mylocal",
      model: "my-model",
    });

    expect(result).toEqual({ status: "available" });
    const request = requireFetchPreflightRequest();
    // No custom headers should be set when headerName is empty
    expect(request.init?.headers).toBeUndefined();
  });

  it("skips header mode auth when value is empty or whitespace-only", async () => {
    mockReachableResponse(200);

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            mylocal: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8080",
              request: {
                auth: {
                  mode: "header",
                  headerName: "X-API-Key",
                  value: "   ",
                },
              },
              models: [],
            },
          },
        },
      },
      provider: "mylocal",
      model: "my-model",
    });

    expect(result).toEqual({ status: "available" });
    const request = requireFetchPreflightRequest();
    // No custom headers should be set when value is whitespace-only
    expect(request.init?.headers).toBeUndefined();
  });

  it("does not fall through to resolveApiKeyForProvider when header mode is used", async () => {
    mockReachableResponse(200);
    resolveApiKeyForProviderMock.mockResolvedValueOnce({
      apiKey: "sk-fallback-key",
      mode: "api-key",
      source: "config",
    });

    await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            mylocal: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8080",
              request: {
                auth: {
                  mode: "header",
                  headerName: "X-Custom",
                  value: "custom-val",
                },
              },
              models: [],
            },
          },
        },
      },
      provider: "mylocal",
      model: "my-model",
    });

    // When mode is "header", resolveApiKeyForProvider should NOT be called
    // The custom header handles auth entirely; no Bearer token should be injected
    expect(resolveApiKeyForProviderMock).not.toHaveBeenCalled();
    const request = requireFetchPreflightRequest();
    // Only the custom header, no Authorization Bearer
    expect(request.init?.headers).toEqual({ "X-Custom": "custom-val" });
  });

  it("sends only custom header (no Authorization) when header mode is used and resolveApiKeyForProvider returns empty", async () => {
    mockReachableResponse(200);
    // Default mock returns { mode: "api-key" } with no apiKey

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            mylocal: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8080",
              request: {
                auth: {
                  mode: "header",
                  headerName: "X-Custom",
                  value: "custom-val",
                },
              },
              models: [],
            },
          },
        },
      },
      provider: "mylocal",
      model: "my-model",
    });

    expect(result).toEqual({ status: "available" });
    const request = requireFetchPreflightRequest();
    // Only the custom header, no Authorization, because resolveApiKeyForProvider returned empty
    expect(request.init?.headers).toEqual({ "X-Custom": "custom-val" });
  });

  it("uses authorization-bearer over header mode (else-if exclusivity)", async () => {
    mockReachableResponse(200);
    // Config sets mode to authorization-bearer, not header
    // Even if headerName/value are present, they should be ignored

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            mylocal: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8080",
              request: {
                auth: {
                  mode: "authorization-bearer",
                  token: "bearer-token",
                },
              },
              models: [],
            },
          },
        },
      },
      provider: "mylocal",
      model: "my-model",
    });

    expect(result).toEqual({ status: "available" });
    const request = requireFetchPreflightRequest();
    expect(request.init?.headers).toEqual({
      Authorization: "Bearer bearer-token",
    });
  });

  it("defaults prefix to empty string when not provided in header mode", async () => {
    mockReachableResponse(200);

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            mylocal: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8080",
              request: {
                auth: {
                  mode: "header",
                  headerName: "X-Auth",
                  value: "raw-value",
                },
              },
              models: [],
            },
          },
        },
      },
      provider: "mylocal",
      model: "my-model",
    });

    expect(result).toEqual({ status: "available" });
    const request = requireFetchPreflightRequest();
    // Without prefix, the value should be sent as-is
    expect(request.init?.headers).toHaveProperty("X-Auth", "raw-value");
  });

  it("does not send Authorization: Bearer when header mode with custom header is configured", async () => {
    mockReachableResponse(200);
    resolveApiKeyForProviderMock.mockResolvedValueOnce({
      apiKey: "sk-existing-key",
      mode: "api-key",
      source: "config",
    });

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            mylocal: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8080",
              request: {
                auth: {
                  mode: "header",
                  headerName: "X-API-Key",
                  value: "custom-val",
                },
              },
              models: [],
            },
          },
        },
      },
      provider: "mylocal",
      model: "my-model",
    });

    expect(result).toEqual({ status: "available" });
    const request = requireFetchPreflightRequest();
    // Only the custom header should be sent — no Authorization Bearer injected
    expect(request.init?.headers).toEqual({ "X-API-Key": "custom-val" });
    expect(request.init?.headers).not.toHaveProperty("Authorization");
  });

  it("header mode with Authorization headerName and prefix suppresses Bearer", async () => {
    mockReachableResponse(200);
    resolveApiKeyForProviderMock.mockResolvedValueOnce({
      apiKey: "sk-existing-key",
      mode: "api-key",
      source: "config",
    });

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            mylocal: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8080",
              request: {
                auth: {
                  mode: "header",
                  headerName: "Authorization",
                  value: "my-custom-token",
                  prefix: "CustomScheme",
                },
              },
              models: [],
            },
          },
        },
      },
      provider: "mylocal",
      model: "my-model",
    });

    expect(result).toEqual({ status: "available" });
    const request = requireFetchPreflightRequest();
    // Only the custom Authorization header with CustomScheme prefix — no Bearer
    expect(request.init?.headers).toEqual({ Authorization: "CustomSchememy-custom-token" });
  });

  // ── Auth parity tests (P0) — verify preflight delegates to resolveProviderRequestHeaders ──

  describe("auth parity with normal model request path", () => {
    it("authorization-bearer mode parity: resolveProviderRequestHeaders handles auth token", async () => {
      mockReachableResponse(200);

      await preflightCronModelProvider({
        cfg: {
          models: {
            providers: {
              test: {
                api: "openai-completions",
                baseUrl: "http://127.0.0.1:8080",
                request: {
                  auth: {
                    mode: "authorization-bearer",
                    token: "parity-test-token",
                  },
                },
                models: [],
              },
            },
          },
        },
        provider: "test",
        model: "test-model",
      });

      // Preflight delegates to resolveProviderRequestHeaders
      expect(resolveProviderRequestHeadersMock).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "test",
          request: expect.objectContaining({
            auth: { mode: "authorization-bearer", token: "parity-test-token" },
          }),
        }),
      );
      const request = requireFetchPreflightRequest();
      expect(request.init?.headers).toEqual({
        Authorization: "Bearer parity-test-token",
      });
    });

    it("header mode parity: resolveProviderRequestHeaders handles custom header", async () => {
      mockReachableResponse(200);

      await preflightCronModelProvider({
        cfg: {
          models: {
            providers: {
              test: {
                api: "openai-completions",
                baseUrl: "http://127.0.0.1:8080",
                request: {
                  auth: {
                    mode: "header",
                    headerName: "X-API-Key",
                    value: "parity-header-key",
                  },
                },
                models: [],
              },
            },
          },
        },
        provider: "test",
        model: "test-model",
      });

      expect(resolveProviderRequestHeadersMock).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "test",
          request: expect.objectContaining({
            auth: {
              mode: "header",
              headerName: "X-API-Key",
              value: "parity-header-key",
            },
          }),
        }),
      );
      const request = requireFetchPreflightRequest();
      expect(request.init?.headers).toEqual({ "X-API-Key": "parity-header-key" });
    });

    it("header mode with prefix parity", async () => {
      mockReachableResponse(200);

      await preflightCronModelProvider({
        cfg: {
          models: {
            providers: {
              test: {
                api: "openai-completions",
                baseUrl: "http://127.0.0.1:8080",
                request: {
                  auth: {
                    mode: "header",
                    headerName: "Authorization",
                    value: "parity-custom-token",
                    prefix: "CustomScheme",
                  },
                },
                models: [],
              },
            },
          },
        },
        provider: "test",
        model: "test-model",
      });

      expect(resolveProviderRequestHeadersMock).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            auth: {
              mode: "header",
              headerName: "Authorization",
              value: "parity-custom-token",
              prefix: "CustomScheme",
            },
          }),
        }),
      );
      const request = requireFetchPreflightRequest();
      expect(request.init?.headers).toEqual({
        Authorization: "CustomSchemeparity-custom-token",
      });
    });

    it("resolveApiKeyForProvider fallback parity", async () => {
      mockReachableResponse(200);
      resolveApiKeyForProviderMock.mockResolvedValueOnce({
        apiKey: "parity-fallback-key",
        mode: "api-key",
        source: "config",
      });

      await preflightCronModelProvider({
        cfg: {
          models: {
            providers: {
              test: {
                api: "openai-completions",
                baseUrl: "http://127.0.0.1:8080",
                models: [],
              },
            },
          },
        },
        provider: "test",
        model: "test-model",
      });

      // resolveApiKeyForProvider should be called for fallback
      expect(resolveApiKeyForProviderMock).toHaveBeenCalled();
      // resolveProviderRequestHeaders should have been called with auth wrapper
      expect(resolveProviderRequestHeadersMock).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            auth: {
              mode: "authorization-bearer",
              token: "parity-fallback-key",
            },
          }),
        }),
      );
      const request = requireFetchPreflightRequest();
      expect(request.init?.headers).toEqual({
        Authorization: "Bearer parity-fallback-key",
      });
    });
  });

  it("resolveApiKeyForProvider fallback sends provider-level headers when providerConfig.headers is set", async () => {
    mockReachableResponse(200);
    // Provider-level headers without any request auth (triggers fallback path)
    resolveApiKeyForProviderMock.mockResolvedValueOnce({
      apiKey: "fallback-provider-key",
      mode: "api-key",
      source: "config",
    });

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            test: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8080",
              headers: { "X-Proxy-Route": "us-east" },
              models: [],
            },
          },
        },
      },
      provider: "test",
      model: "test-model",
    });

    expect(result).toEqual({ status: "available" });
    // Primary call with no auth + provider headers
    expect(resolveProviderRequestHeadersMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        defaultHeaders: { "X-Proxy-Route": "us-east" },
        request: undefined,
      }),
    );
    // Fallback call with resolved bearer auth + provider headers
    expect(resolveProviderRequestHeadersMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        defaultHeaders: { "X-Proxy-Route": "us-east" },
        request: expect.objectContaining({
          auth: expect.objectContaining({
            mode: "authorization-bearer",
            token: "fallback-provider-key",
          }),
        }),
      }),
    );
    const request = requireFetchPreflightRequest();
    expect(request.init?.headers).toHaveProperty("X-Proxy-Route", "us-east");
    expect(request.init?.headers).toHaveProperty("Authorization", "Bearer fallback-provider-key");
  });

  it("preserves request.headers in fallback call when resolveApiKeyForProvider resolves", async () => {
    mockReachableResponse(200);
    resolveApiKeyForProviderMock.mockResolvedValueOnce({
      apiKey: "fallback-key-with-headers",
      mode: "api-key",
      source: "config",
    });

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            test: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8080",
              headers: { "X-Proxy-Route": "us-east" },
              request: {
                headers: { "X-Tenant-Id": "tenant-xyz" },
              },
              models: [],
            },
          },
        },
      },
      provider: "test",
      model: "test-model",
    });

    expect(result).toEqual({ status: "available" });
    // Primary call: request headers passed through
    expect(resolveProviderRequestHeadersMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        defaultHeaders: { "X-Proxy-Route": "us-east" },
        request: {
          headers: { "X-Tenant-Id": "tenant-xyz" },
        },
      }),
    );
    // Fallback call: request headers preserved alongside resolved bearer auth
    expect(resolveProviderRequestHeadersMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        defaultHeaders: { "X-Proxy-Route": "us-east" },
        request: {
          headers: { "X-Tenant-Id": "tenant-xyz" },
          auth: { mode: "authorization-bearer", token: "fallback-key-with-headers" },
        },
      }),
    );
    const request = requireFetchPreflightRequest();
    expect(request.init?.headers).toHaveProperty("X-Tenant-Id", "tenant-xyz");
    expect(request.init?.headers).toHaveProperty("X-Proxy-Route", "us-east");
    expect(request.init?.headers).toHaveProperty(
      "Authorization",
      "Bearer fallback-key-with-headers",
    );
  });

  it("treats provider-default auth mode as fallback-triggering no-auth", async () => {
    mockReachableResponse(200);
    resolveApiKeyForProviderMock.mockResolvedValueOnce({
      apiKey: "provider-default-key",
      mode: "api-key",
      source: "env",
    });

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            test: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8080",
              request: { auth: { mode: "provider-default" } },
              models: [],
            },
          },
        },
      },
      provider: "test",
      model: "test-model",
    });

    expect(result).toEqual({ status: "available" });
    // Primary call: provider-default auth passed to resolver
    expect(resolveProviderRequestHeadersMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        request: { auth: { mode: "provider-default" } },
      }),
    );
    // Fallback call: resolved bearer auth replaces provider-default
    expect(resolveProviderRequestHeadersMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        request: {
          auth: { mode: "authorization-bearer", token: "provider-default-key" },
        },
      }),
    );
    const request = requireFetchPreflightRequest();
    expect(request.init?.headers).toHaveProperty("Authorization", "Bearer provider-default-key");
  });

  it("preserves request.headers in fallback when provider-default mode is configured", async () => {
    mockReachableResponse(200);
    resolveApiKeyForProviderMock.mockResolvedValueOnce({
      apiKey: "pd-key-with-headers",
      mode: "api-key",
      source: "env",
    });

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            test: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8080",
              headers: { "X-Proxy-Route": "us-east" },
              request: {
                auth: { mode: "provider-default" },
                headers: { "X-Tenant-Id": "tenant-xyz" },
              },
              models: [],
            },
          },
        },
      },
      provider: "test",
      model: "test-model",
    });

    expect(result).toEqual({ status: "available" });
    // Fallback call: request.headers preserved, auth replaced with bearer
    expect(resolveProviderRequestHeadersMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        defaultHeaders: { "X-Proxy-Route": "us-east" },
        request: {
          headers: { "X-Tenant-Id": "tenant-xyz" },
          auth: { mode: "authorization-bearer", token: "pd-key-with-headers" },
        },
      }),
    );
    const request = requireFetchPreflightRequest();
    expect(request.init?.headers).toHaveProperty("Authorization", "Bearer pd-key-with-headers");
    expect(request.init?.headers).toHaveProperty("X-Tenant-Id", "tenant-xyz");
    expect(request.init?.headers).toHaveProperty("X-Proxy-Route", "us-east");
  });

  // ── Provider-level headers (P1) — verify providerConfig.headers pass through defaultHeaders ──

  it("sends provider-level headers when providerConfig.headers is set", async () => {
    mockReachableResponse(200);

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            test: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8080",
              headers: { "X-Tenant-Id": "tenant-abc", "X-Proxy-Version": "2" },
              models: [],
            },
          },
        },
      },
      provider: "test",
      model: "test-model",
    });

    expect(result).toEqual({ status: "available" });
    // Preflight passes defaultHeaders to resolveProviderRequestHeaders
    expect(resolveProviderRequestHeadersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "test",
        defaultHeaders: { "X-Tenant-Id": "tenant-abc", "X-Proxy-Version": "2" },
      }),
    );
    const request = requireFetchPreflightRequest();
    expect(request.init?.headers).toHaveProperty("X-Tenant-Id", "tenant-abc");
    expect(request.init?.headers).toHaveProperty("X-Proxy-Version", "2");
  });

  it("merges provider-level headers with request auth headers", async () => {
    mockReachableResponse(200);

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            test: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8080",
              headers: { "X-Tenant-Id": "tenant-abc" },
              request: {
                auth: {
                  mode: "authorization-bearer",
                  token: "my-token",
                },
              },
              models: [],
            },
          },
        },
      },
      provider: "test",
      model: "test-model",
    });

    expect(result).toEqual({ status: "available" });
    const request = requireFetchPreflightRequest();
    expect(request.init?.headers).toHaveProperty("X-Tenant-Id", "tenant-abc");
    expect(request.init?.headers).toHaveProperty("Authorization", "Bearer my-token");
  });

  it("passes provider-level headers without any auth config", async () => {
    mockReachableResponse(200);

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            test: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8080",
              headers: { "X-Custom": "header-only" },
              models: [],
            },
          },
        },
      },
      provider: "test",
      model: "test-model",
    });

    expect(result).toEqual({ status: "available" });
    const request = requireFetchPreflightRequest();
    expect(request.init?.headers).toEqual({ "X-Custom": "header-only" });
  });

  it("strips secret-ref marker values from providerConfig.headers", async () => {
    mockReachableResponse(200);

    // "secretref-managed" and "secretref-env:*" are real sentinel values that
    // isSecretRefHeaderValueMarker treats as unresolved secret references.
    // sanitizeModelHeaders filters them out so preflight never sends literal
    // placeholder strings as header values.
    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            test: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8080",
              headers: {
                "X-Api-Key": "secretref-managed",
                "X-Env-Key": "secretref-env:MY_VAR",
                "X-Valid": "valid-value",
              },
              models: [],
            },
          },
        },
      },
      provider: "test",
      model: "test-model",
    });

    expect(result).toEqual({ status: "available" });
    // Secret-ref markers are stripped; only the valid string passes through
    expect(resolveProviderRequestHeadersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultHeaders: { "X-Valid": "valid-value" },
      }),
    );
    const request = requireFetchPreflightRequest();
    expect(request.init?.headers).toEqual({ "X-Valid": "valid-value" });
  });

  it("strips non-string values from providerConfig.headers", async () => {
    mockReachableResponse(200);

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            test: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8080",
              headers: {
                "X-Valid": "ok",
                "X-Number": 123 as unknown as string,
                "X-Null": null as unknown as string,
              },
              models: [],
            },
          },
        },
      },
      provider: "test",
      model: "test-model",
    });

    expect(result).toEqual({ status: "available" });
    // Non-string values are filtered by sanitizeModelHeaders; only string values survive
    expect(resolveProviderRequestHeadersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultHeaders: { "X-Valid": "ok" },
      }),
    );
    const request = requireFetchPreflightRequest();
    expect(request.init?.headers).toEqual({ "X-Valid": "ok" });
    expect(request.init?.headers).not.toHaveProperty("X-Number");
    expect(request.init?.headers).not.toHaveProperty("X-Null");
  });

  it("passes undefined defaultHeaders when providerConfig.headers is not set", async () => {
    mockReachableResponse(200);

    await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            test: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8080",
              models: [],
            },
          },
        },
      },
      provider: "test",
      model: "test-model",
    });

    expect(resolveProviderRequestHeadersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultHeaders: undefined,
      }),
    );
  });

  it("passes undefined defaultHeaders when providerConfig.headers is empty", async () => {
    mockReachableResponse(200);

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            test: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8080",
              headers: {},
              models: [],
            },
          },
        },
      },
      provider: "test",
      model: "test-model",
    });

    expect(result).toEqual({ status: "available" });
    expect(resolveProviderRequestHeadersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultHeaders: undefined,
      }),
    );
  });

  // ── Auth edge case tests (P1) — boundary and fallback conditions ──

  describe("auth edge cases", () => {
    it("header mode with empty headerName/value falls through to fallback after sanitizer drops auth", async () => {
      mockReachableResponse(200);
      resolveApiKeyForProviderMock.mockResolvedValueOnce({
        apiKey: "fallback-from-empty-header",
        mode: "api-key",
        source: "config",
      });

      await preflightCronModelProvider({
        cfg: {
          models: {
            providers: {
              test: {
                api: "openai-completions",
                baseUrl: "http://127.0.0.1:8080",
                request: {
                  auth: {
                    mode: "header",
                    headerName: "",
                    value: "",
                  },
                },
                models: [],
              },
            },
          },
        },
        provider: "test",
        model: "test-model",
      });

      // sanitizeConfiguredProviderRequest drops mode:header with empty
      // headerName/value, so fallback should be called (no header mode to block it)
      expect(resolveApiKeyForProviderMock).toHaveBeenCalled();
      expect(resolveProviderRequestHeadersMock).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "test",
          request: expect.objectContaining({
            auth: expect.objectContaining({
              mode: "authorization-bearer",
              token: "fallback-from-empty-header",
            }),
          }),
        }),
      );
      const request = requireFetchPreflightRequest();
      expect(request.init?.headers).toEqual({
        Authorization: "Bearer fallback-from-empty-header",
      });
    });

    it("unknown mode value falls through to resolveApiKeyForProvider", async () => {
      mockReachableResponse(200);
      resolveApiKeyForProviderMock.mockResolvedValueOnce({
        apiKey: "fallback-for-unknown-mode",
        mode: "api-key",
        source: "config",
      });

      await preflightCronModelProvider({
        cfg: {
          models: {
            providers: {
              test: {
                api: "openai-completions",
                baseUrl: "http://127.0.0.1:8080",
                request: {
                  auth: {
                    mode: "api-key" as any,
                    token: "ignored",
                  },
                },
                models: [],
              },
            },
          },
        },
        provider: "test",
        model: "test-model",
      });

      expect(resolveApiKeyForProviderMock).toHaveBeenCalled();
      expect(resolveProviderRequestHeadersMock).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            auth: { mode: "authorization-bearer", token: "fallback-for-unknown-mode" },
          }),
        }),
      );
      const request = requireFetchPreflightRequest();
      expect(request.init?.headers).toEqual({
        Authorization: "Bearer fallback-for-unknown-mode",
      });
    });

    it("authorization-bearer with empty/whitespace token falls through to resolveApiKeyForProvider", async () => {
      mockReachableResponse(200);
      resolveApiKeyForProviderMock.mockResolvedValueOnce({
        apiKey: "fallback-after-empty-token",
        mode: "api-key",
        source: "config",
      });

      await preflightCronModelProvider({
        cfg: {
          models: {
            providers: {
              test: {
                api: "openai-completions",
                baseUrl: "http://127.0.0.1:8080",
                request: {
                  auth: {
                    mode: "authorization-bearer",
                    token: "   ",
                  },
                },
                models: [],
              },
            },
          },
        },
        provider: "test",
        model: "test-model",
      });

      // authorization-bearer with empty token should fall through
      expect(resolveApiKeyForProviderMock).toHaveBeenCalled();
      const request = requireFetchPreflightRequest();
      expect(request.init?.headers).toEqual({
        Authorization: "Bearer fallback-after-empty-token",
      });
    });

    it("OAuth marker with mode api-key sends no Authorization header", async () => {
      mockReachableResponse(200);
      resolveApiKeyForProviderMock.mockResolvedValueOnce({
        apiKey: "oauth-token-456",
        mode: "oauth",
        source: "auth-profile",
      });

      await preflightCronModelProvider({
        cfg: {
          models: {
            providers: {
              test: {
                api: "openai-completions",
                baseUrl: "http://127.0.0.1:8080",
                models: [],
              },
            },
          },
        },
        provider: "test",
        model: "test-model",
      });

      expect(resolveApiKeyForProviderMock).toHaveBeenCalled();
      // OAuth credentials should not be sent in preflight probes
      const request = requireFetchPreflightRequest();
      expect(request.init?.headers).toBeUndefined();
    });
  });
});
