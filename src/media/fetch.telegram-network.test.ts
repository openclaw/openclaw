import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveTelegramTransport,
  shouldRetryTelegramTransportFallback,
} from "../../extensions/telegram/src/fetch.js";
import { makeProxyFetch } from "../../extensions/telegram/src/proxy.js";
import { TEST_UNDICI_RUNTIME_DEPS_KEY } from "../infra/net/undici-runtime.js";
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
  beforeEach(() => {
    undiciMocks.fetch.mockReset();
    undiciMocks.agentCtor.mockClear();
    undiciMocks.envHttpProxyAgentCtor.mockClear();
    undiciMocks.proxyAgentCtor.mockClear();
    (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: undiciMocks.agentCtor,
      EnvHttpProxyAgent: undiciMocks.envHttpProxyAgentCtor,
      ProxyAgent: undiciMocks.proxyAgentCtor,
    };
  });

  function createTelegramFetchFailedError(code: string): Error {
    return Object.assign(new TypeError("fetch failed"), {
      cause: { code },
    });
  }

  afterEach(() => {
    Reflect.deleteProperty(globalThis as object, TEST_UNDICI_RUNTIME_DEPS_KEY);
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
      dispatcherAttempts: telegramTransport.dispatcherAttempts,
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
      dispatcherAttempts: telegramTransport.dispatcherAttempts,
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

  it("classifies Telegram transport network failures as retryable", () => {
    expect(
      shouldRetryTelegramTransportFallback(createTelegramFetchFailedError("EHOSTUNREACH")),
    ).toBe(true);
    expect(shouldRetryTelegramTransportFallback(createTelegramFetchFailedError("ETIMEDOUT"))).toBe(
      true,
    );
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
      dispatcherAttempts: telegramTransport.dispatcherAttempts,
      shouldRetryFetchError: () => true,
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

  it("retries Telegram file downloads with pinned Telegram IP after IPv4 fallback fails", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "149.154.167.221", family: 4 },
      { address: "2001:67c:4e8:f004::9", family: 6 },
    ]) as unknown as LookupFn;
    undiciMocks.fetch
      .mockRejectedValueOnce(createTelegramFetchFailedError("EHOSTUNREACH"))
      .mockRejectedValueOnce(createTelegramFetchFailedError("ETIMEDOUT"))
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
      url: "https://api.telegram.org/file/bottok/photos/3.jpg",
      fetchImpl: telegramTransport.sourceFetch,
      dispatcherAttempts: telegramTransport.dispatcherAttempts,
      shouldRetryFetchError: () => true,
      lookupFn,
      maxBytes: 1024,
      ssrfPolicy: {
        allowedHostnames: ["api.telegram.org"],
        allowRfc2544BenchmarkRange: true,
      },
    });

    const thirdInit = undiciMocks.fetch.mock.calls[2]?.[1] as
      | (RequestInit & {
          dispatcher?: {
            options?: {
              connect?: Record<string, unknown>;
            };
          };
        })
      | undefined;
    const callback = vi.fn();
    (
      thirdInit?.dispatcher?.options?.connect?.lookup as
        | ((
            hostname: string,
            callback: (err: null, address: string, family: number) => void,
          ) => void)
        | undefined
    )?.("api.telegram.org", callback);

    expect(undiciMocks.fetch).toHaveBeenCalledTimes(3);
    expect(thirdInit?.dispatcher?.options?.connect).toEqual(
      expect.objectContaining({
        family: 4,
        autoSelectFamily: false,
        lookup: expect.any(Function),
      }),
    );
    expect(callback).toHaveBeenCalledWith(null, "149.154.167.220", 4);
  });

  it("preserves both primary and final fallback errors when Telegram media retry chain fails", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "149.154.167.220", family: 4 },
      { address: "2001:67c:4e8:f004::9", family: 6 },
    ]) as unknown as LookupFn;
    const primaryError = createTelegramFetchFailedError("EHOSTUNREACH");
    const ipv4Error = createTelegramFetchFailedError("ETIMEDOUT");
    const fallbackError = createTelegramFetchFailedError("ETIMEDOUT");
    undiciMocks.fetch
      .mockRejectedValueOnce(primaryError)
      .mockRejectedValueOnce(ipv4Error)
      .mockRejectedValueOnce(fallbackError);

    const telegramTransport = resolveTelegramTransport(undefined, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "ipv4first",
      },
    });

    await expect(
      fetchRemoteMedia({
        url: "https://api.telegram.org/file/bottok/photos/4.jpg",
        fetchImpl: telegramTransport.sourceFetch,
        dispatcherAttempts: telegramTransport.dispatcherAttempts,
        shouldRetryFetchError: () => true,
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
        attemptErrors: [primaryError, ipv4Error, fallbackError],
        primaryError,
      }),
    });
  });
});
