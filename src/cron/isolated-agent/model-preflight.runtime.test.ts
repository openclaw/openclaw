import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import { mockFirstObjectArg } from "../../test-utils/mock-call-assertions.js";

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

function makeLocalPreflightParams(
  provider: "ollama" | "vllm",
): Parameters<typeof preflightCronModelProvider>[0] {
  return {
    cfg: {
      models: {
        providers: {
          [provider]: {
            api: provider === "ollama" ? "ollama" : "openai-completions",
            baseUrl: provider === "ollama" ? "http://localhost:11434" : "http://127.0.0.1:8000/v1",
            models: [],
          },
        },
      },
    },
    provider,
    model: provider === "ollama" ? "qwen3:32b" : "llama",
  };
}

function mockReachableResponse(status = 200) {
  fetchWithSsrFGuardMock.mockResolvedValueOnce({
    response: { status },
    release: vi.fn(async () => {}),
  });
}

describe("preflightCronModelProvider", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    resetCronModelProviderPreflightCacheForTest();
  });

  it("skips network checks for a non-local provider", async () => {
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

  it("starts unread-body cancellation before release without waiting for a split stream", async () => {
    const cleanupOrder: string[] = [];
    const cancel = vi.fn(() => {
      cleanupOrder.push("cancel");
      return new Promise<void>(() => {});
    });
    const release = vi.fn(async () => {
      cleanupOrder.push("release");
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: { status: 200, bodyUsed: false, body: { cancel } },
      release,
    });
    const params = makeLocalPreflightParams("vllm");

    const result = await withTestTimeout(
      preflightCronModelProvider(params),
      1_000,
      "cron provider preflight waited for unread response-body cancellation",
    );
    const cached = await preflightCronModelProvider({
      ...params,
      model: "llama-cached",
    });

    expect(result).toEqual({ status: "available" });
    expect(cached).toEqual({ status: "available" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    expect(cleanupOrder).toEqual(["cancel", "release"]);
  });

  it("keeps a reachable provider available when response cancellation rejects", async () => {
    const cancel = vi.fn(async () => {
      throw new Error("provider response was already closed");
    });
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: { status: 401, bodyUsed: false, body: { cancel } },
      release,
    });

    const result = await preflightCronModelProvider(makeLocalPreflightParams("vllm"));

    expect(result).toEqual({ status: "available" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
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
    expect(first.reason).toContain("the local provider preflight failed");
    expect(first.reason).toContain("Start the local provider or correct its configured endpoint");
    expect(first.reason).not.toContain("endpoint is not reachable");
    expect(first.reason).toContain("Last error: ECONNREFUSED");
    expect(first.reason).not.toContain("timed out after");
    expect(second.status).toBe("unavailable");
    if (second.status !== "unavailable") {
      throw new Error(`expected second preflight unavailable, got ${second.status}`);
    }
    expect(second.provider).toBe("ollama");
    expect(second.model).toBe("llama3.3:70b");
    expect(second.baseUrl).toBe("http://localhost:11434");
    expect(second.retryAfterMs).toBe(300000);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    const request = mockFirstObjectArg(fetchWithSsrFGuardMock);
    expect(request.url).toBe("http://localhost:11434/api/tags");
    expect(request.auditContext).toBe("cron-model-provider-preflight");
  });

  it("reprobes after a nested client timeout", async () => {
    const timeout = new DOMException("request timed out", "TimeoutError");
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new TypeError("fetch failed", { cause: timeout }));
    mockReachableResponse();
    const params = makeLocalPreflightParams("vllm");

    const first = await preflightCronModelProvider({
      ...params,
      model: "first",
      nowMs: 1000,
    });
    const next = await preflightCronModelProvider({
      ...params,
      model: "next",
      nowMs: 2000,
    });

    expect(first.status).toBe("unavailable");
    expect(first).toMatchObject({
      reason: expect.stringContaining(
        "Local provider preflight exceeded its configured 2500ms deadline | fetch failed | request timed out",
      ),
    });
    expect(next).toEqual({ status: "available" });
  });

  it("bounds long diagnostics without splitting UTF-16 surrogate pairs", async () => {
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error(`${"x".repeat(992)}😀truncated-detail`));

    const result = await preflightCronModelProvider(makeLocalPreflightParams("ollama"));

    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") {
      throw new Error(`expected preflight unavailable, got ${result.status}`);
    }
    const diagnostic = result.reason.split("Last error: ")[1];
    expect(diagnostic).toHaveLength(1_000);
    expect(diagnostic).toMatch(/^x{992}😀trunc…$/u);
    expect(diagnostic).not.toContain("truncated-detail");
    expect(/[\uD800-\uDBFF]$/u.test(diagnostic ?? "")).toBe(false);
  });
});
