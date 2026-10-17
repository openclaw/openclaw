import net from "node:net";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ssrf from "../../infra/net/ssrf.js";
import {
  preflightCronModelProvider,
  resetCronModelProviderPreflightCacheForTest,
} from "./model-preflight.runtime.js";

const connectMock = vi.spyOn(net, "connect");

function makeLocalPreflightParams(provider: "ollama" | "vllm", baseUrl?: string) {
  return {
    cfg: {
      models: {
        providers: {
          [provider]: {
            api: provider === "ollama" ? ("ollama" as const) : ("openai-completions" as const),
            baseUrl:
              baseUrl ??
              (provider === "ollama" ? "http://localhost:11434" : "http://127.0.0.1:8000/v1"),
            models: [],
          },
        },
      },
    },
    provider,
    model: provider === "ollama" ? "qwen3:32b" : "llama",
  };
}

function socketResult(error?: Error) {
  const socket = new net.Socket();
  queueMicrotask(() => (error ? socket.destroy(error) : socket.emit("connect")));
  return socket;
}

function mockReachableEndpoint() {
  connectMock.mockImplementationOnce(() => socketResult());
}

function mockUnavailableEndpoint(error: Error) {
  connectMock.mockImplementationOnce(() => socketResult(error));
}

describe("preflightCronModelProvider", () => {
  beforeEach(() => {
    connectMock.mockReset();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", undefined);
    resetCronModelProviderPreflightCacheForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  afterAll(() => connectMock.mockRestore());

  it.each(["https://api.openai.com/v1"])(
    "skips network checks for non-local provider URL %s",
    async (baseUrl) => {
      const params = makeLocalPreflightParams("vllm", baseUrl);
      expect(await preflightCronModelProvider(params)).toEqual({ status: "available" });
      expect(connectMock).not.toHaveBeenCalled();
    },
  );

  it.each(["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.0.222", "[::1]", "[::ffff:7f00:1]"])(
    "checks local endpoint host %s without retaining its socket or timer",
    async (host) => {
      mockReachableEndpoint();
      const params = makeLocalPreflightParams("vllm", `http://${host}:8000/v1`);
      expect(await preflightCronModelProvider(params)).toEqual({ status: "available" });
      expect(connectMock.mock.results[0]?.value.destroyed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    ["http://127.0.0.1/v1", 80],
    ["https://127.0.0.1/v1", 443],
  ] as const)("uses the protocol's default port for %s", async (baseUrl, port) => {
    mockReachableEndpoint();
    const params = makeLocalPreflightParams("vllm", baseUrl);
    expect(await preflightCronModelProvider(params)).toEqual({ status: "available" });
    expect(connectMock).toHaveBeenCalledWith(expect.objectContaining({ port }));
  });

  it("rejects non-HTTP provider protocols before connecting", async () => {
    const params = makeLocalPreflightParams("vllm", "ftp://127.0.0.1:8000");
    expect(await preflightCronModelProvider(params)).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("Unsupported local provider protocol"),
    });
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("caches connection failures per endpoint while preserving each model's diagnostic", async () => {
    mockUnavailableEndpoint(new Error("ECONNREFUSED"));
    const params = makeLocalPreflightParams("ollama");
    const first = await preflightCronModelProvider({ ...params, nowMs: 1000 });
    const second = await preflightCronModelProvider({ ...params, model: "second", nowMs: 2000 });
    expect(first).toMatchObject({
      status: "unavailable",
      provider: "ollama",
      model: "qwen3:32b",
      baseUrl: "http://localhost:11434",
      retryAfterMs: 300000,
      reason: expect.stringContaining("Last error: ECONNREFUSED"),
    });
    expect(second).toMatchObject({ status: "unavailable", model: "second" });
    expect(connectMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries an unavailable endpoint after the cache ttl", async () => {
    mockUnavailableEndpoint(new Error("ECONNREFUSED"));
    mockReachableEndpoint();
    const params = makeLocalPreflightParams("ollama");
    expect(await preflightCronModelProvider({ ...params, nowMs: 1000 })).toMatchObject({
      status: "unavailable",
    });
    expect(await preflightCronModelProvider({ ...params, nowMs: 301001 })).toEqual({
      status: "available",
    });
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it("closes timed-out connections and retries on the next run", async () => {
    const started = Promise.withResolvers<net.Socket>();
    connectMock.mockImplementationOnce(() => {
      const socket = new net.Socket();
      started.resolve(socket);
      return socket;
    });
    const params = makeLocalPreflightParams("vllm");
    const pending = preflightCronModelProvider({ ...params, nowMs: 1000 });
    const socket = await started.promise;
    await vi.advanceTimersByTimeAsync(2500);
    expect(await pending).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("preflight exceeded its configured 2500ms deadline"),
    });
    expect(socket.destroyed).toBe(true);
    mockReachableEndpoint();
    expect(await preflightCronModelProvider({ ...params, nowMs: 2000 })).toEqual({
      status: "available",
    });
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("includes DNS resolution in the same deadline", async () => {
    const lookup = vi
      .spyOn(ssrf, "resolvePinnedHostnameWithPolicy")
      .mockImplementationOnce((_hostname, options = {}) => {
        const { signal } = options;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("DNS lookup canceled", { cause: signal.reason })),
            { once: true },
          );
        });
      });
    try {
      const pending = preflightCronModelProvider(makeLocalPreflightParams("ollama"));
      await vi.advanceTimersByTimeAsync(2500);
      expect(await pending).toMatchObject({
        status: "unavailable",
        reason: expect.stringContaining("preflight exceeded its configured 2500ms deadline"),
      });
      expect(connectMock).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      lookup.mockRestore();
    }
  });

  it("preserves nested abort details without classifying a generic abort as timeout", async () => {
    const connectionError = Object.assign(new Error("connect ECONNREFUSED"), {
      name: "ConnectError",
      code: "ECONNREFUSED",
    });
    mockUnavailableEndpoint(
      Object.assign(new Error("request aborted", { cause: connectionError }), {
        name: "AbortError",
        code: "ABORT_ERR",
      }),
    );
    const result = await preflightCronModelProvider(makeLocalPreflightParams("ollama"));
    expect(result).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining(
        "Last error: request aborted | ABORT_ERR | connect ECONNREFUSED | ECONNREFUSED",
      ),
    });
    expect(result).not.toHaveProperty("reason", expect.stringContaining("exceeded"));
  });

  it("bounds cyclic cause-chain inspection", async () => {
    const errors = Array.from({ length: 12 }, (_, index) =>
      Object.assign(new Error(`failure-${index}`), {
        name: `NestedError${index}`,
        code: `ELOOP${index}`,
        cause: undefined as unknown,
      }),
    );
    for (let index = 0; index < errors.length - 1; index += 1) {
      errors[index]!.cause = errors[index + 1];
    }
    errors.at(-1)!.cause = errors[0];
    mockUnavailableEndpoint(errors[0]!);
    const result = await preflightCronModelProvider(makeLocalPreflightParams("ollama"));
    if (result.status !== "unavailable") {
      throw new Error(`expected preflight unavailable, got ${result.status}`);
    }
    expect(result.reason.match(/failure-0/g)).toHaveLength(1);
    expect(result.reason).toContain("failure-7 | ELOOP7");
    expect(result.reason).toContain("failure-11 | ELOOP11");
    expect(result.reason).not.toContain("NestedError");
  });

  it("bounds long diagnostics without splitting UTF-16 surrogate pairs", async () => {
    mockUnavailableEndpoint(new Error(`${"x".repeat(992)}😀truncated-detail`));
    const result = await preflightCronModelProvider(makeLocalPreflightParams("ollama"));
    if (result.status !== "unavailable") {
      throw new Error(`expected preflight unavailable, got ${result.status}`);
    }
    const diagnostic = result.reason.split("Last error: ")[1];
    expect(diagnostic).toHaveLength(1000);
    expect(diagnostic).toMatch(/^x{992}😀trunc…$/u);
    expect(diagnostic).not.toContain("truncated-detail");
    expect(/[\uD800-\uDBFF]$/u.test(diagnostic ?? "")).toBe(false);
  });

  it.each([false, true])(
    "defers managed proxy routing unless NO_PROXY bypasses it (%s)",
    async (bypass) => {
      vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
      vi.stubEnv("HTTP_PROXY", "http://proxy.example.test:8080");
      vi.stubEnv("http_proxy", undefined);
      vi.stubEnv("NO_PROXY", bypass ? "127.0.0.1" : "");
      vi.stubEnv("no_proxy", undefined);
      if (bypass) {
        mockReachableEndpoint();
      }
      expect(await preflightCronModelProvider(makeLocalPreflightParams("vllm"))).toEqual({
        status: "available",
      });
      expect(connectMock).toHaveBeenCalledTimes(bypass ? 1 : 0);
    },
  );
});
