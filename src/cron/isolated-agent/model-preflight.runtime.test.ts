// Runtime model preflight tests cover provider/model checks before cron execution.
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetchWithSsrFGuardMock,
  shouldUseEnvHttpProxyForUrlMock,
  withTrustedEnvProxyGuardedFetchModeMock,
} = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
  shouldUseEnvHttpProxyForUrlMock: vi.fn(() => false),
  withTrustedEnvProxyGuardedFetchModeMock: vi.fn((params: Record<string, unknown>) => ({
    ...params,
    mode: "trusted_env_proxy",
  })),
}));

vi.mock("../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  withTrustedEnvProxyGuardedFetchMode: withTrustedEnvProxyGuardedFetchModeMock,
}));

vi.mock("../../infra/net/proxy-env.js", () => ({
  shouldUseEnvHttpProxyForUrl: shouldUseEnvHttpProxyForUrlMock,
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
  mode?: string;
} {
  const request = fetchWithSsrFGuardMock.mock.calls[0]?.[0] as
    | { url?: string; timeoutMs?: number; auditContext?: string; mode?: string }
    | undefined;
  if (!request) {
    throw new Error("Expected cron model preflight fetch request");
  }
  return request;
}

describe("preflightCronModelProvider", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    shouldUseEnvHttpProxyForUrlMock.mockReset();
    shouldUseEnvHttpProxyForUrlMock.mockReturnValue(false);
    withTrustedEnvProxyGuardedFetchModeMock.mockClear();
    resetCronModelProviderPreflightCacheForTest();
  });

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

  it("uses trusted-env-proxy mode when the env proxy applies, mirroring the runner", async () => {
    // Proxy-routed local vhosts (e.g. `inference.local`) need the env proxy;
    // STRICT pinning would EAI_AGAIN. The runner uses env proxy, so the
    // preflight must mirror it or it false-negatives and skips every run.
    shouldUseEnvHttpProxyForUrlMock.mockReturnValue(true);
    mockReachableResponse(200);

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            openshell: {
              api: "openai-completions",
              baseUrl: "http://inference.local/v1",
              models: [],
            },
          },
        },
      },
      provider: "openshell",
      model: "qwen3",
    });

    expect(result).toEqual({ status: "available" });
    expect(withTrustedEnvProxyGuardedFetchModeMock).toHaveBeenCalledTimes(1);
    const request = requireFetchPreflightRequest();
    expect(request.url).toBe("http://inference.local/v1/models");
    expect(request.mode).toBe("trusted_env_proxy");
  });

  it("keeps strict mode when the env proxy does not apply", async () => {
    mockReachableResponse(200);

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
    expect(withTrustedEnvProxyGuardedFetchModeMock).not.toHaveBeenCalled();
    const request = requireFetchPreflightRequest();
    expect(request.mode).toBeUndefined();
  });
});
