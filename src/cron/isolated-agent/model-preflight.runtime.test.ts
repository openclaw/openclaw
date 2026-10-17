import net from "node:net";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ssrf from "../../infra/net/ssrf.js";
import {
  preflightCronModelProvider as preflight,
  resetCronModelProviderPreflightCacheForTest,
} from "./model-preflight.runtime.js";

const connectMock = vi.spyOn(net, "connect");

function makeLocalPreflightParams(provider: "ollama" | "vllm", baseUrl?: string) {
  const local = provider === "ollama";
  const config = {
    api: local ? ("ollama" as const) : ("openai-completions" as const),
    baseUrl: baseUrl ?? (local ? "http://localhost:11434" : "http://127.0.0.1:8000/v1"),
    models: [],
  };
  return {
    cfg: { models: { providers: { [provider]: config } } },
    provider,
    model: local ? "qwen3:32b" : "llama",
  };
}
const ollama = makeLocalPreflightParams("ollama");
const vllm = makeLocalPreflightParams("vllm");

function socketResult(error?: Error) {
  const socket = new net.Socket();
  queueMicrotask(() => (error ? socket.destroy(error) : socket.emit("connect")));
  return socket;
}

function mockEndpoint(error?: Error) {
  connectMock.mockImplementationOnce(() => socketResult(error));
}

type PreflightParams = Parameters<typeof preflight>[0];
async function expectAvailable(params: PreflightParams) {
  expect(await preflight(params)).toEqual({ status: "available" });
}
function expectUnavailable(result: Awaited<ReturnType<typeof preflight>>) {
  expect(result.status).toBe("unavailable");
  if (result.status !== "unavailable") {
    throw new Error(`expected preflight unavailable, got ${result.status}`);
  }
  return result.reason;
}
const deadline = expect.stringContaining("preflight exceeded its configured 2500ms deadline");

async function failureReason(error: Error) {
  mockEndpoint(error);
  return expectUnavailable(await preflight(ollama));
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

  it("skips network checks for remote providers", async () => {
    await expectAvailable(makeLocalPreflightParams("vllm", "https://api.openai.com/v1"));
    expect(connectMock).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.0.222", "[::1]", "[::ffff:7f00:1]"])(
    "checks local endpoint host %s without retaining its socket or timer",
    async (host) => {
      mockEndpoint();
      await expectAvailable(makeLocalPreflightParams("vllm", `http://${host}:8000/v1`));
      expect(connectMock.mock.results[0]?.value.destroyed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    ["http://127.0.0.1/v1", 80],
    ["https://127.0.0.1/v1", 443],
  ] as const)("uses the protocol's default port for %s", async (baseUrl, port) => {
    mockEndpoint();
    await expectAvailable(makeLocalPreflightParams("vllm", baseUrl));
    expect(connectMock).toHaveBeenCalledWith(expect.objectContaining({ port }));
  });

  it("rejects non-HTTP provider protocols before connecting", async () => {
    const params = makeLocalPreflightParams("vllm", "ftp://127.0.0.1:8000");
    expect(await preflight(params)).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("Unsupported local provider protocol"),
    });
    expect(connectMock).not.toHaveBeenCalled();
  });

  it.each([false, true])("caches endpoint failures until expiry (expired=%s)", async (expired) => {
    mockEndpoint(new Error("ECONNREFUSED"));
    if (expired) {
      mockEndpoint();
    }
    const first = await preflight({ ...ollama, nowMs: 1000 });
    const second = await preflight({
      ...ollama,
      model: expired ? ollama.model : "second",
      nowMs: expired ? 301001 : 2000,
    });
    expect(first).toMatchObject({
      status: "unavailable",
      provider: "ollama",
      model: "qwen3:32b",
      baseUrl: "http://localhost:11434",
      retryAfterMs: 300000,
      reason: expect.stringContaining("Last error: ECONNREFUSED"),
    });
    if (expired) {
      expect(second).toEqual({ status: "available" });
    } else {
      expect(second).toMatchObject({ status: "unavailable", model: "second" });
    }
    expect(connectMock).toHaveBeenCalledTimes(expired ? 2 : 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["socket", "DNS"])("bounds %s work by the preflight deadline", async (stage) => {
    const started = Promise.withResolvers<net.Socket>();
    const lookup =
      stage === "DNS"
        ? vi.spyOn(ssrf, "resolvePinnedHostnameWithPolicy").mockImplementationOnce(
            (_hostname, { signal } = {}) =>
              new Promise((_resolve, reject) => {
                signal?.addEventListener(
                  "abort",
                  () => reject(new Error("DNS lookup canceled", { cause: signal.reason })),
                  { once: true },
                );
              }),
          )
        : undefined;
    if (!lookup) {
      connectMock.mockImplementationOnce(() => {
        const socket = new net.Socket();
        started.resolve(socket);
        return socket;
      });
    }
    try {
      const pending = preflight(lookup ? ollama : { ...vllm, nowMs: 1000 });
      const socket = lookup ? undefined : await started.promise;
      await vi.advanceTimersByTimeAsync(2500);
      expect(await pending).toMatchObject({ status: "unavailable", reason: deadline });
      if (socket) {
        expect(socket.destroyed).toBe(true);
        mockEndpoint();
        await expectAvailable({ ...vllm, nowMs: 2000 });
        expect(connectMock).toHaveBeenCalledTimes(2);
      } else {
        expect(connectMock).not.toHaveBeenCalled();
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      lookup?.mockRestore();
    }
  });

  it("preserves nested abort details without classifying a generic abort as timeout", async () => {
    const connectionError = Object.assign(new Error("connect ECONNREFUSED"), {
      name: "ConnectError",
      code: "ECONNREFUSED",
    });
    const reason = await failureReason(
      Object.assign(new Error("request aborted", { cause: connectionError }), {
        name: "AbortError",
        code: "ABORT_ERR",
      }),
    );
    expect(reason).toContain(
      "Last error: request aborted | ABORT_ERR | connect ECONNREFUSED | ECONNREFUSED",
    );
    expect(reason).not.toContain("exceeded");
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
    const reason = await failureReason(errors[0]!);
    expect(reason.match(/failure-0/g)).toHaveLength(1);
    expect(reason).toContain("failure-7 | ELOOP7");
    expect(reason).toContain("failure-11 | ELOOP11");
    expect(reason).not.toContain("NestedError");
  });

  it("bounds long diagnostics without splitting UTF-16 surrogate pairs", async () => {
    const diagnostic = (
      await failureReason(new Error(`${"x".repeat(992)}😀truncated-detail`))
    ).split("Last error: ")[1];
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
        mockEndpoint();
      }
      await expectAvailable(vllm);
      expect(connectMock).toHaveBeenCalledTimes(bypass ? 1 : 0);
    },
  );
});
