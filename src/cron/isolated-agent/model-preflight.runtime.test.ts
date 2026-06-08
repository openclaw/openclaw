// Runtime model preflight tests cover provider/model checks before cron execution.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
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
    resetCronModelProviderPreflightCacheForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it("retries local provider preflight when configured", async () => {
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("warming up"));
    mockReachableResponse(200);

    const result = await preflightCronModelProvider({
      cfg: {
        cron: {
          modelPreflight: {
            maxAttempts: 2,
            retryDelayMs: 0,
            timeoutMs: 10_000,
          },
        },
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://192.168.1.117:11434",
              models: [],
            },
          },
        },
      },
      provider: "ollama",
      model: "qwen3:14b",
    });

    expect(result).toEqual({ status: "available" });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
    const request = requireFetchPreflightRequest();
    expect(request.url).toBe("http://192.168.1.117:11434/api/tags");
    expect(request.timeoutMs).toBe(10000);
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

  it("reports configured attempts after repeated local provider preflight failures", async () => {
    fetchWithSsrFGuardMock
      .mockRejectedValueOnce(new Error("starting"))
      .mockRejectedValueOnce(new Error("still starting"));

    const result = await preflightCronModelProvider({
      cfg: {
        cron: {
          modelPreflight: {
            maxAttempts: 2,
            retryDelayMs: 0,
          },
        },
        models: {
          providers: {
            ollama: {
              api: "ollama" as const,
              baseUrl: "http://localhost:11434",
              models: [],
            },
          },
        },
      },
      provider: "ollama",
      model: "qwen3:14b",
      nowMs: 1000,
    });

    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") {
      throw new Error(`expected preflight unavailable, got ${result.status}`);
    }
    expect(result.reason).toContain("after 2 preflight attempts");
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
  });

  it("does not probe a second local candidate after the shared chain deadline expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("first endpoint unavailable"));

    const cfg = {
      models: {
        providers: {
          first: {
            api: "openai-completions" as const,
            baseUrl: "http://127.0.0.1:18001/v1",
            models: [],
          },
          second: {
            api: "openai-completions" as const,
            baseUrl: "http://127.0.0.1:18002/v1",
            models: [],
          },
        },
      },
    };
    const deadlineMs = 1_200;

    const first = await preflightCronModelProvider({
      cfg,
      provider: "first",
      model: "local-one",
      deadlineMs,
    });
    expect(first.status).toBe("unavailable");
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    expect(requireFetchPreflightRequest().timeoutMs).toBe(200);

    vi.setSystemTime(deadlineMs);
    const second = await preflightCronModelProvider({
      cfg,
      provider: "second",
      model: "local-two",
      deadlineMs,
    });

    expect(second.status).toBe("unavailable");
    if (second.status !== "unavailable") {
      throw new Error(`expected second preflight unavailable, got ${second.status}`);
    }
    expect(second.reason).toContain("chain budget exhausted");
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
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
});
