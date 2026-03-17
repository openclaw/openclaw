import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

let resolveTelegramTransport: typeof import("../../extensions/telegram/src/fetch.js").resolveTelegramTransport;
let shouldRetryTelegramIpv4Fallback: typeof import("../../extensions/telegram/src/fetch.js").shouldRetryTelegramIpv4Fallback;
let fetchRemoteMedia: typeof import("./fetch.js").fetchRemoteMedia;

describe("fetchRemoteMedia telegram network policy", () => {
  type LookupFn = NonNullable<Parameters<typeof fetchRemoteMedia>[0]["lookupFn"]>;

  beforeEach(async () => {
    vi.resetModules();
    ({ resolveTelegramTransport, shouldRetryTelegramIpv4Fallback } =
      await import("../../extensions/telegram/src/fetch.js"));
    ({ fetchRemoteMedia } = await import("./fetch.js"));
  });

  function createTelegramFetchFailedError(code: string): Error {
    return Object.assign(new TypeError("fetch failed"), {
      cause: { code },
    });
  }

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
    const { makeProxyFetch } = await import("../../extensions/telegram/src/proxy.js");
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

  it("retries Telegram file downloads with IPv4 fallback when the first fetch fails", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "149.154.167.220", family: 4 },
      { address: "2001:67c:4e8:f004::9", family: 6 },
    ]) as unknown as LookupFn;
    undiciMocks.fetch
      .mockRejectedValueOnce(createTelegramFetchFailedError("EHOSTUNREACH"))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
      );

    const telegramTransport = resolveTelegramTransport(undefined, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "ipv4first",
      },
    });

    await fetchRemoteMedia({
      url: "https://api.telegram.org/file/bottok/photos/2.jpg",
      fetchImpl: telegramTransport.sourceFetch,
      dispatcherPolicy: telegramTransport.pinnedDispatcherPolicy,
      fallbackDispatcherPolicy: telegramTransport.fallbackPinnedDispatcherPolicy,
      shouldRetryFetchError: shouldRetryTelegramIpv4Fallback,
      lookupFn,
      maxBytes: 1024,
      ssrfPolicy: {
        allowedHostnames: ["api.telegram.org"],
        allowRfc2544BenchmarkRange: true,
      },
    });

    const firstInit = undiciMocks.fetch.mock.calls[0]?.[1] as
      | (RequestInit & {
          dispatcher?: {
            options?: {
              connect?: Record<string, unknown>;
            };
          };
        })
      | undefined;
    const secondInit = undiciMocks.fetch.mock.calls[1]?.[1] as
      | (RequestInit & {
          dispatcher?: {
            options?: {
              connect?: Record<string, unknown>;
            };
          };
        })
      | undefined;

    expect(undiciMocks.fetch).toHaveBeenCalledTimes(2);
    expect(firstInit?.dispatcher?.options?.connect).toEqual(
      expect.objectContaining({
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
        lookup: expect.any(Function),
      }),
    );
    expect(secondInit?.dispatcher?.options?.connect).toEqual(
      expect.objectContaining({
        family: 4,
        autoSelectFamily: false,
        lookup: expect.any(Function),
      }),
    );
  });

  it("preserves both primary and fallback errors when Telegram media retry fails twice", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "149.154.167.220", family: 4 },
      { address: "2001:67c:4e8:f004::9", family: 6 },
    ]) as unknown as LookupFn;
    const primaryError = createTelegramFetchFailedError("EHOSTUNREACH");
    const fallbackError = createTelegramFetchFailedError("ETIMEDOUT");
    undiciMocks.fetch.mockRejectedValueOnce(primaryError).mockRejectedValueOnce(fallbackError);

    const telegramTransport = resolveTelegramTransport(undefined, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "ipv4first",
      },
    });

    await expect(
      fetchRemoteMedia({
        url: "https://api.telegram.org/file/bottok/photos/3.jpg",
        fetchImpl: telegramTransport.sourceFetch,
        dispatcherPolicy: telegramTransport.pinnedDispatcherPolicy,
        fallbackDispatcherPolicy: telegramTransport.fallbackPinnedDispatcherPolicy,
        shouldRetryFetchError: shouldRetryTelegramIpv4Fallback,
        lookupFn,
        maxBytes: 1024,
        ssrfPolicy: {
          allowedHostnames: ["api.telegram.org"],
          allowRfc2544BenchmarkRange: true,
        },
      }),
    ).rejects.toMatchObject({
      name: "MediaFetchError",
      code: "fetch_failed",
      cause: expect.objectContaining({
        name: "Error",
        cause: fallbackError,
        primaryError,
      }),
    });
  });
});
