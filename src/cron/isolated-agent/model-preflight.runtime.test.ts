// Runtime model preflight tests cover provider/model checks before cron execution.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchOperatorConfiguredEndpointMock } = vi.hoisted(() => ({
  fetchOperatorConfiguredEndpointMock: vi.fn(),
}));

vi.mock("../../infra/net/egress-fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/net/egress-fetch.js")>()),
  fetchOperatorConfiguredEndpoint: fetchOperatorConfiguredEndpointMock,
}));

import {
  preflightCronModelProvider,
  resetCronModelProviderPreflightCacheForTest,
} from "./model-preflight.runtime.js";

function mockReachableResponse(status = 200) {
  fetchOperatorConfiguredEndpointMock.mockResolvedValueOnce({
    response: { status },
    release: vi.fn(async () => {}),
  });
}

function requireFetchPreflightRequest(): {
  url?: string;
  timeoutMs?: number;
  operation?: string;
} {
  const request = fetchOperatorConfiguredEndpointMock.mock.calls[0]?.[0] as
    | { url?: string; timeoutMs?: number; operation?: string }
    | undefined;
  if (!request) {
    throw new Error("Expected cron model preflight fetch request");
  }
  return request;
}

describe("preflightCronModelProvider", () => {
  beforeEach(() => {
    fetchOperatorConfiguredEndpointMock.mockReset();
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
    expect(fetchOperatorConfiguredEndpointMock).not.toHaveBeenCalled();
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
    fetchOperatorConfiguredEndpointMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

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
    expect(fetchOperatorConfiguredEndpointMock).toHaveBeenCalledTimes(1);
    const request = requireFetchPreflightRequest();
    expect(request.url).toBe("http://localhost:11434/api/tags");
    expect(request.operation).toBe("cron-model-provider-preflight");
  });

  it("retries an unavailable endpoint after the cache ttl", async () => {
    fetchOperatorConfiguredEndpointMock
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({
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
    expect(fetchOperatorConfiguredEndpointMock).toHaveBeenCalledTimes(2);
  });
});
