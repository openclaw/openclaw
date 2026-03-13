import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTelegramTransport } from "../telegram/fetch.js";
import { fetchRemoteMedia } from "./fetch.js";

const undiciMocks = vi.hoisted(() => {
  const createDispatcherCtor = <T extends Record<string, unknown> | string>() =>
    vi.fn(function MockDispatcher(this: { options?: T }, options?: T) {
      this.options = options;
    });

  return {
    fetch: vi.fn(),
    agentCtor: createDispatcherCtor<Record<string, unknown>>(),
    envHttpProxyAgentCtor: createDispatcherCtor<Record<string, unknown>>(),
    proxyAgentCtor: createDispatcherCtor<Record<string, unknown> | string>(),
  };
});

vi.mock("undici", () => ({
  Agent: undiciMocks.agentCtor,
  EnvHttpProxyAgent: undiciMocks.envHttpProxyAgentCtor,
  ProxyAgent: undiciMocks.proxyAgentCtor,
  fetch: undiciMocks.fetch,
}));

describe("fetchRemoteMedia telegram network policy", () => {
  type LookupFn = NonNullable<Parameters<typeof fetchRemoteMedia>[0]["lookupFn"]>;

  afterEach(() => {
    undiciMocks.fetch.mockReset();
    undiciMocks.agentCtor.mockClear();
    undiciMocks.envHttpProxyAgentCtor.mockClear();
    undiciMocks.proxyAgentCtor.mockClear();
    vi.unstubAllEnvs();
  });

  it("preserves Telegram resolver transport policy for file downloads", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "149.154.167.220", family: 4 },
    ]) as unknown as LookupFn;
    undiciMocks.fetch.mockResolvedValueOnce(
      new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );

    const telegramTransport = resolveTelegramTransport(undefined, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "verbatim",
      },
    });

    await fetchRemoteMedia({
      url: "https://api.telegram.org/file/bottok/photos/1.jpg",
      fetchImpl: telegramTransport.sourceFetch,
      dispatcherPolicy: telegramTransport.pinnedDispatcherPolicy,
      lookupFn,
      maxBytes: 1024,
      ssrfPolicy: {
        allowedHostnames: ["api.telegram.org"],
        allowRfc2544BenchmarkRange: true,
      },
    });

    const init = undiciMocks.fetch.mock.calls[0]?.[1] as
      | (RequestInit & {
          dispatcher?: {
            options?: {
              connect?: Record<string, unknown>;
            };
          };
        })
      | undefined;

    expect(init?.dispatcher?.options?.connect).toEqual(
      expect.objectContaining({
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
        lookup: expect.any(Function),
      }),
    );
  });

  it("keeps explicit proxy routing for file downloads", async () => {
    const { makeProxyFetch } = await import("../telegram/proxy.js");
    const lookupFn = vi.fn(async () => [
      { address: "149.154.167.220", family: 4 },
    ]) as unknown as LookupFn;
    undiciMocks.fetch.mockResolvedValueOnce(
      new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    );

    const telegramTransport = resolveTelegramTransport(makeProxyFetch("http://127.0.0.1:7890"), {
      network: {
        autoSelectFamily: false,
        dnsResultOrder: "ipv4first",
      },
    });

    await fetchRemoteMedia({
      url: "https://api.telegram.org/file/bottok/files/1.pdf",
      fetchImpl: telegramTransport.sourceFetch,
      dispatcherPolicy: telegramTransport.pinnedDispatcherPolicy,
      lookupFn,
      maxBytes: 1024,
      ssrfPolicy: {
        allowedHostnames: ["api.telegram.org"],
        allowRfc2544BenchmarkRange: true,
      },
    });

    const init = undiciMocks.fetch.mock.calls[0]?.[1] as
      | (RequestInit & {
          dispatcher?: {
            options?: {
              uri?: string;
            };
          };
        })
      | undefined;

    expect(init?.dispatcher?.options?.uri).toBe("http://127.0.0.1:7890");
    expect(undiciMocks.proxyAgentCtor).toHaveBeenCalled();
  });
});
