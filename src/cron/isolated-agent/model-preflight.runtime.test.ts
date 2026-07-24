// Runtime model preflight tests cover provider/model checks before cron execution.
import { beforeEach, describe, expect, it, vi } from "vitest";

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

  it("reports timeout error with 'timed out after' in the preflight reason", async () => {
    // Simulate the real error chain from fetch-with-timeout:
    // fetch aborts with Error (name="TimeoutError") as abort reason
    const timeoutCause = new Error("request timed out");
    timeoutCause.name = "TimeoutError";
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new TypeError("fetch failed", { cause: timeoutCause }));

    const result = await preflightCronModelProvider({
      cfg: {
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
      model: "qwen3:32b",
      nowMs: 1000,
    });

    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") {
      throw new Error();
    }
    expect(result.reason).toContain("timed out after");
    expect(result.reason).not.toContain("not reachable");
  });

  it("surfaces the full cause chain for non-timeout protocol errors", async () => {
    // Simulate a protocol error where the server responded but with a
    // malformed response (e.g. duplicate Content-Length headers).
    const causeErr = new Error("Response body length does not match content-length header");
    causeErr.name = "ResponseContentLengthMismatchError";
    (causeErr as unknown as Record<string, string>).code = "UND_ERR_RES_CONTENT_LENGTH_MISMATCH";
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new TypeError("fetch failed", { cause: causeErr }));

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            vllm: {
              api: "openai-completions" as const,
              baseUrl: "http://127.0.0.1:8000/v1",
              models: [],
            },
          },
        },
      },
      provider: "vllm",
      model: "llama",
      nowMs: 1000,
    });

    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") {
      throw new Error();
    }
    expect(result.reason).toContain("the endpoint may have responded");
    expect(result.reason).toContain("Response body length does not match content-length header");
    expect(result.reason).toContain("UND_ERR_RES_CONTENT_LENGTH_MISMATCH");
  });

  it("includes elapsed time in the preflight reason", async () => {
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            ollama: {
              api: "ollama" as const,
              baseUrl: "http://127.0.0.1:11434",
              models: [],
            },
          },
        },
      },
      provider: "ollama",
      model: "llama3",
      nowMs: 1000,
    });

    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") {
      throw new Error();
    }
    // With a mock that rejects immediately, elapsedMs should be a small non-negative number
    expect(result.reason).toMatch(/failed after \d+ms/);
  });

  it("preserves elapsedMs in the cache-hit preflight reason", async () => {
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

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
      model: "qwen3:32b",
      nowMs: 1000,
    });
    const second = await preflightCronModelProvider({
      cfg,
      provider: "ollama",
      model: "llama3:70b",
      nowMs: 2000,
    });

    expect(first.status).toBe("unavailable");
    expect(second.status).toBe("unavailable");
    if (first.status !== "unavailable" || second.status !== "unavailable") {
      throw new Error();
    }
    // Both cache miss and cache hit should include elapsed time in the reason
    expect(first.reason).toMatch(/failed after \d+ms/);
    expect(second.reason).toMatch(/failed after \d+ms/);
  });
});
