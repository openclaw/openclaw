import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveFetch } from "../infra/fetch.js";
import { resolveTelegramFetch, resolveTelegramTransport } from "./fetch.js";

const setDefaultResultOrder = vi.hoisted(() => vi.fn());
const setDefaultAutoSelectFamily = vi.hoisted(() => vi.fn());

const undiciFetch = vi.hoisted(() => vi.fn());
const setGlobalDispatcher = vi.hoisted(() => vi.fn());
const AgentCtor = vi.hoisted(() =>
  vi.fn(function MockAgent(
    this: { options?: Record<string, unknown> },
    options?: Record<string, unknown>,
  ) {
    this.options = options;
  }),
);
const EnvHttpProxyAgentCtor = vi.hoisted(() =>
  vi.fn(function MockEnvHttpProxyAgent(
    this: { options?: Record<string, unknown> },
    options?: Record<string, unknown>,
  ) {
    this.options = options;
  }),
);
const ProxyAgentCtor = vi.hoisted(() =>
  vi.fn(function MockProxyAgent(
    this: { options?: Record<string, unknown> | string },
    options?: Record<string, unknown> | string,
  ) {
    this.options = options;
  }),
);

vi.mock("node:dns", async () => {
  const actual = await vi.importActual<typeof import("node:dns")>("node:dns");
  return {
    ...actual,
    setDefaultResultOrder,
  };
});

vi.mock("node:net", async () => {
  const actual = await vi.importActual<typeof import("node:net")>("node:net");
  return {
    ...actual,
    setDefaultAutoSelectFamily,
  };
});

vi.mock("undici", () => ({
  Agent: AgentCtor,
  EnvHttpProxyAgent: EnvHttpProxyAgentCtor,
  ProxyAgent: ProxyAgentCtor,
  fetch: undiciFetch,
  setGlobalDispatcher,
}));

function resolveTelegramFetchOrThrow(
  proxyFetch?: typeof fetch,
  options?: { network?: { autoSelectFamily?: boolean; dnsResultOrder?: "ipv4first" | "verbatim" } },
) {
  return resolveTelegramFetch(proxyFetch, options);
}

function getDispatcherFromUndiciCall(nth: number) {
  const call = undiciFetch.mock.calls[nth - 1] as [RequestInfo | URL, RequestInit?] | undefined;
  if (!call) {
    throw new Error(`missing undici fetch call #${nth}`);
  }
  const init = call[1] as (RequestInit & { dispatcher?: unknown }) | undefined;
  return init?.dispatcher as
    | {
        options?: {
          connect?: Record<string, unknown>;
          proxyTls?: Record<string, unknown>;
        };
      }
    | undefined;
}

function buildFetchFallbackError(code: string) {
  const connectErr = Object.assign(new Error(`connect ${code} api.telegram.org:443`), {
    code,
  });
  return Object.assign(new TypeError("fetch failed"), {
    cause: connectErr,
  });
}

const STICKY_IPV4_FALLBACK_NETWORK = {
  network: {
    autoSelectFamily: true,
    dnsResultOrder: "ipv4first" as const,
  },
};

async function runDefaultStickyIpv4FallbackProbe(code = "EHOSTUNREACH"): Promise<void> {
  undiciFetch
    .mockRejectedValueOnce(buildFetchFallbackError(code))
    .mockResolvedValueOnce({ ok: true } as Response)
    .mockResolvedValueOnce({ ok: true } as Response);

  const resolved = resolveTelegramFetchOrThrow(undefined, STICKY_IPV4_FALLBACK_NETWORK);
  await resolved("https://api.telegram.org/botx/sendMessage");
  await resolved("https://api.telegram.org/botx/sendChatAction");
}

function expectPinnedIpv4ConnectDispatcher(args: {
  pinnedCall: number;
  firstCall?: number;
  followupCall?: number;
}): void {
  const pinnedDispatcher = getDispatcherFromUndiciCall(args.pinnedCall);
  expect(pinnedDispatcher?.options?.connect).toEqual(
    expect.objectContaining({
      family: 4,
      autoSelectFamily: false,
    }),
  );
  if (args.firstCall) {
    expect(getDispatcherFromUndiciCall(args.firstCall)).not.toBe(pinnedDispatcher);
  }
  if (args.followupCall) {
    expect(getDispatcherFromUndiciCall(args.followupCall)).toBe(pinnedDispatcher);
  }
}

afterEach(() => {
  undiciFetch.mockReset();
  setGlobalDispatcher.mockReset();
  AgentCtor.mockClear();
  EnvHttpProxyAgentCtor.mockClear();
  ProxyAgentCtor.mockClear();
  setDefaultResultOrder.mockReset();
  setDefaultAutoSelectFamily.mockReset();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("resolveTelegramFetch", () => {
  it("wraps proxy fetches and leaves retry policy to caller-provided fetch", async () => {
    const proxyFetch = vi.fn(async () => ({ ok: true }) as Response) as unknown as typeof fetch;

    const resolved = resolveTelegramFetchOrThrow(proxyFetch);

    await resolved("https://api.telegram.org/botx/getMe");

    expect(proxyFetch).toHaveBeenCalledTimes(1);
    expect(undiciFetch).not.toHaveBeenCalled();
  });

  it("does not double-wrap an already wrapped proxy fetch", async () => {
    const proxyFetch = vi.fn(async () => ({ ok: true }) as Response) as unknown as typeof fetch;
    const wrapped = resolveFetch(proxyFetch);

    const resolved = resolveTelegramFetch(wrapped);

    expect(resolved).toBe(wrapped);
  });

  it("uses resolver-scoped Agent dispatcher with configured transport policy", async () => {
    undiciFetch.mockResolvedValue({ ok: true } as Response);

    const resolved = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "verbatim",
      },
    });

    await resolved("https://api.telegram.org/botx/getMe");

    expect(AgentCtor).toHaveBeenCalledTimes(1);
    expect(EnvHttpProxyAgentCtor).not.toHaveBeenCalled();

    const dispatcher = getDispatcherFromUndiciCall(1);
    expect(dispatcher).toBeDefined();
    expect(dispatcher?.options?.connect).toEqual(
      expect.objectContaining({
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
      }),
    );
    expect(typeof dispatcher?.options?.connect?.lookup).toBe("function");
  });

  it("uses EnvHttpProxyAgent dispatcher when proxy env is configured", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7890");
    undiciFetch.mockResolvedValue({ ok: true } as Response);

    const resolved = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: false,
        dnsResultOrder: "ipv4first",
      },
    });

    await resolved("https://api.telegram.org/botx/getMe");

    expect(EnvHttpProxyAgentCtor).toHaveBeenCalledTimes(1);
    expect(AgentCtor).not.toHaveBeenCalled();

    const dispatcher = getDispatcherFromUndiciCall(1);
    expect(dispatcher?.options?.connect).toEqual(
      expect.objectContaining({
        autoSelectFamily: false,
        autoSelectFamilyAttemptTimeout: 300,
      }),
    );
    expect(dispatcher?.options?.proxyTls).toEqual(
      expect.objectContaining({
        autoSelectFamily: false,
        autoSelectFamilyAttemptTimeout: 300,
      }),
    );
  });

  it("pins env-proxy transport policy onto proxyTls for proxied HTTPS requests", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7890");
    undiciFetch.mockResolvedValue({ ok: true } as Response);

    const resolved = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "ipv4first",
      },
    });

    await resolved("https://api.telegram.org/botx/getMe");

    const dispatcher = getDispatcherFromUndiciCall(1);
    expect(dispatcher?.options?.connect).toEqual(
      expect.objectContaining({
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
      }),
    );
    expect(dispatcher?.options?.proxyTls).toEqual(
      expect.objectContaining({
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
      }),
    );
  });

  it("keeps resolver-scoped transport policy for OpenClaw proxy fetches", async () => {
    const { makeProxyFetch } = await import("./proxy.js");
    const proxyFetch = makeProxyFetch("http://127.0.0.1:7890");
    ProxyAgentCtor.mockClear();
    undiciFetch.mockResolvedValue({ ok: true } as Response);

    const resolved = resolveTelegramFetchOrThrow(proxyFetch, {
      network: {
        autoSelectFamily: false,
        dnsResultOrder: "ipv4first",
      },
    });

    await resolved("https://api.telegram.org/botx/getMe");

    expect(ProxyAgentCtor).toHaveBeenCalledTimes(1);
    expect(EnvHttpProxyAgentCtor).not.toHaveBeenCalled();
    expect(AgentCtor).not.toHaveBeenCalled();
    const dispatcher = getDispatcherFromUndiciCall(1);
    expect(dispatcher?.options).toEqual(
      expect.objectContaining({
        uri: "http://127.0.0.1:7890",
      }),
    );
    expect(dispatcher?.options?.proxyTls).toEqual(
      expect.objectContaining({
        autoSelectFamily: false,
      }),
    );
  });

  it("does not blind-retry when sticky IPv4 fallback is disallowed for explicit proxy paths", async () => {
    const { makeProxyFetch } = await import("./proxy.js");
    const proxyFetch = makeProxyFetch("http://127.0.0.1:7890");
    ProxyAgentCtor.mockClear();
    const fetchError = buildFetchFallbackError("EHOSTUNREACH");
    undiciFetch.mockRejectedValueOnce(fetchError).mockResolvedValueOnce({ ok: true } as Response);

    const resolved = resolveTelegramFetchOrThrow(proxyFetch, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "ipv4first",
      },
    });

    await expect(resolved("https://api.telegram.org/botx/sendMessage")).rejects.toThrow(
      "fetch failed",
    );
    await resolved("https://api.telegram.org/botx/sendChatAction");

    expect(undiciFetch).toHaveBeenCalledTimes(2);
    expect(ProxyAgentCtor).toHaveBeenCalledTimes(1);

    const firstDispatcher = getDispatcherFromUndiciCall(1);
    const secondDispatcher = getDispatcherFromUndiciCall(2);

    expect(firstDispatcher).toBe(secondDispatcher);
    expect(firstDispatcher?.options?.proxyTls).toEqual(
      expect.objectContaining({
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
      }),
    );
    expect(firstDispatcher?.options?.proxyTls?.family).not.toBe(4);
  });

  it("does not blind-retry when sticky IPv4 fallback is disallowed for env proxy paths", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7890");
    const fetchError = buildFetchFallbackError("EHOSTUNREACH");
    undiciFetch.mockRejectedValueOnce(fetchError).mockResolvedValueOnce({ ok: true } as Response);

    const resolved = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "ipv4first",
      },
    });

    await expect(resolved("https://api.telegram.org/botx/sendMessage")).rejects.toThrow(
      "fetch failed",
    );
    await resolved("https://api.telegram.org/botx/sendChatAction");

    expect(undiciFetch).toHaveBeenCalledTimes(2);
    expect(EnvHttpProxyAgentCtor).toHaveBeenCalledTimes(1);

    const firstDispatcher = getDispatcherFromUndiciCall(1);
    const secondDispatcher = getDispatcherFromUndiciCall(2);

    expect(firstDispatcher).toBe(secondDispatcher);
    expect(firstDispatcher?.options?.connect).toEqual(
      expect.objectContaining({
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
      }),
    );
    expect(firstDispatcher?.options?.connect?.family).not.toBe(4);
  });

  it("treats ALL_PROXY-only env as direct transport and arms sticky IPv4 fallback", async () => {
    vi.stubEnv("ALL_PROXY", "socks5://127.0.0.1:1080");
    undiciFetch
      .mockRejectedValueOnce(buildFetchFallbackError("EHOSTUNREACH"))
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockResolvedValueOnce({ ok: true } as Response);

    const transport = resolveTelegramTransport(undefined, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "ipv4first",
      },
    });
    const resolved = transport.fetch;

    await resolved("https://api.telegram.org/botx/sendMessage");
    await resolved("https://api.telegram.org/botx/sendChatAction");

    expect(EnvHttpProxyAgentCtor).not.toHaveBeenCalled();
    expect(AgentCtor).toHaveBeenCalledTimes(2);

    expectPinnedIpv4ConnectDispatcher({
      firstCall: 1,
      pinnedCall: 2,
      followupCall: 3,
    });
    expect(transport.pinnedDispatcherPolicy).toEqual(
      expect.objectContaining({
        mode: "direct",
      }),
    );
  });

  it("arms sticky IPv4 fallback when env proxy init falls back to direct Agent", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7890");
    EnvHttpProxyAgentCtor.mockImplementationOnce(function ThrowingEnvProxyAgent() {
      throw new Error("invalid proxy config");
    });
    await runDefaultStickyIpv4FallbackProbe();

    expect(undiciFetch).toHaveBeenCalledTimes(3);
    expect(EnvHttpProxyAgentCtor).toHaveBeenCalledTimes(1);
    expect(AgentCtor).toHaveBeenCalledTimes(2);

    expectPinnedIpv4ConnectDispatcher({
      firstCall: 1,
      pinnedCall: 2,
      followupCall: 3,
    });
  });

  it("arms sticky IPv4 fallback when NO_PROXY bypasses telegram under env proxy", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7890");
    vi.stubEnv("NO_PROXY", "api.telegram.org");
    await runDefaultStickyIpv4FallbackProbe();

    expect(undiciFetch).toHaveBeenCalledTimes(3);
    expect(EnvHttpProxyAgentCtor).toHaveBeenCalledTimes(2);
    expect(AgentCtor).not.toHaveBeenCalled();

    expectPinnedIpv4ConnectDispatcher({
      firstCall: 1,
      pinnedCall: 2,
      followupCall: 3,
    });
  });

  it("uses no_proxy over NO_PROXY when deciding env-proxy bypass", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7890");
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("no_proxy", "api.telegram.org");
    await runDefaultStickyIpv4FallbackProbe();

    expect(EnvHttpProxyAgentCtor).toHaveBeenCalledTimes(2);
    expectPinnedIpv4ConnectDispatcher({ pinnedCall: 2 });
  });

  it("matches whitespace and wildcard no_proxy entries like EnvHttpProxyAgent", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7890");
    vi.stubEnv("no_proxy", "localhost *.telegram.org");
    await runDefaultStickyIpv4FallbackProbe();

    expect(EnvHttpProxyAgentCtor).toHaveBeenCalledTimes(2);
    expectPinnedIpv4ConnectDispatcher({ pinnedCall: 2 });
  });

  it("fails closed when explicit proxy dispatcher initialization fails", async () => {
    const { makeProxyFetch } = await import("./proxy.js");
    const proxyFetch = makeProxyFetch("http://127.0.0.1:7890");
    ProxyAgentCtor.mockClear();
    ProxyAgentCtor.mockImplementationOnce(function ThrowingProxyAgent() {
      throw new Error("invalid proxy config");
    });

    expect(() =>
      resolveTelegramFetchOrThrow(proxyFetch, {
        network: {
          autoSelectFamily: true,
          dnsResultOrder: "ipv4first",
        },
      }),
    ).toThrow("explicit proxy dispatcher init failed: invalid proxy config");
  });

  it("falls back to Agent when env proxy dispatcher initialization fails", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7890");
    EnvHttpProxyAgentCtor.mockImplementationOnce(function ThrowingEnvProxyAgent() {
      throw new Error("invalid proxy config");
    });
    undiciFetch.mockResolvedValue({ ok: true } as Response);

    const resolved = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: false,
      },
    });

    await resolved("https://api.telegram.org/botx/getMe");

    expect(EnvHttpProxyAgentCtor).toHaveBeenCalledTimes(1);
    expect(AgentCtor).toHaveBeenCalledTimes(1);

    const dispatcher = getDispatcherFromUndiciCall(1);
    expect(dispatcher?.options?.connect).toEqual(
      expect.objectContaining({
        autoSelectFamily: false,
      }),
    );
  });

  it("retries once and then keeps sticky IPv4 dispatcher for subsequent requests", async () => {
    const fetchError = buildFetchFallbackError("ETIMEDOUT");
    undiciFetch
      .mockRejectedValueOnce(fetchError)
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockResolvedValueOnce({ ok: true } as Response);

    const resolved = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: true,
      },
    });

    await resolved("https://api.telegram.org/botx/sendMessage");
    await resolved("https://api.telegram.org/botx/sendChatAction");

    expect(undiciFetch).toHaveBeenCalledTimes(3);

    const firstDispatcher = getDispatcherFromUndiciCall(1);
    const secondDispatcher = getDispatcherFromUndiciCall(2);
    const thirdDispatcher = getDispatcherFromUndiciCall(3);

    expect(firstDispatcher).toBeDefined();
    expect(secondDispatcher).toBeDefined();
    expect(thirdDispatcher).toBeDefined();

    expect(firstDispatcher).not.toBe(secondDispatcher);
    expect(secondDispatcher).toBe(thirdDispatcher);

    expect(firstDispatcher?.options?.connect).toEqual(
      expect.objectContaining({
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
      }),
    );
    expect(secondDispatcher?.options?.connect).toEqual(
      expect.objectContaining({
        family: 4,
        autoSelectFamily: false,
      }),
    );
  });

  it("preserves caller-provided dispatcher across fallback retry", async () => {
    const fetchError = buildFetchFallbackError("EHOSTUNREACH");
    undiciFetch.mockRejectedValueOnce(fetchError).mockResolvedValueOnce({ ok: true } as Response);

    const resolved = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: true,
      },
    });

    const callerDispatcher = { name: "caller" };

    await resolved("https://api.telegram.org/botx/sendMessage", {
      dispatcher: callerDispatcher,
    } as RequestInit);

    expect(undiciFetch).toHaveBeenCalledTimes(2);

    const firstCallInit = undiciFetch.mock.calls[0]?.[1] as
      | (RequestInit & { dispatcher?: unknown })
      | undefined;
    const secondCallInit = undiciFetch.mock.calls[1]?.[1] as
      | (RequestInit & { dispatcher?: unknown })
      | undefined;

    expect(firstCallInit?.dispatcher).toBe(callerDispatcher);
    expect(secondCallInit?.dispatcher).toBe(callerDispatcher);
  });

  it("does not arm sticky fallback from caller-provided dispatcher failures", async () => {
    const fetchError = buildFetchFallbackError("EHOSTUNREACH");
    undiciFetch
      .mockRejectedValueOnce(fetchError)
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockResolvedValueOnce({ ok: true } as Response);

    const resolved = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: true,
      },
    });

    const callerDispatcher = { name: "caller" };

    await resolved("https://api.telegram.org/botx/sendMessage", {
      dispatcher: callerDispatcher,
    } as RequestInit);
    await resolved("https://api.telegram.org/botx/sendChatAction");

    expect(undiciFetch).toHaveBeenCalledTimes(3);

    const firstCallInit = undiciFetch.mock.calls[0]?.[1] as
      | (RequestInit & { dispatcher?: unknown })
      | undefined;
    const secondCallInit = undiciFetch.mock.calls[1]?.[1] as
      | (RequestInit & { dispatcher?: unknown })
      | undefined;
    const thirdDispatcher = getDispatcherFromUndiciCall(3);

    expect(firstCallInit?.dispatcher).toBe(callerDispatcher);
    expect(secondCallInit?.dispatcher).toBe(callerDispatcher);
    expect(thirdDispatcher?.options?.connect).toEqual(
      expect.objectContaining({
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
      }),
    );
    expect(thirdDispatcher?.options?.connect?.family).not.toBe(4);
  });

  it("does not retry when error codes do not match fallback rules", async () => {
    const fetchError = buildFetchFallbackError("ECONNRESET");
    undiciFetch.mockRejectedValue(fetchError);

    const resolved = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: true,
      },
    });

    await expect(resolved("https://api.telegram.org/botx/sendMessage")).rejects.toThrow(
      "fetch failed",
    );

    expect(undiciFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps per-resolver transport policy isolated across multiple accounts", async () => {
    undiciFetch.mockResolvedValue({ ok: true } as Response);

    const resolverA = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: false,
        dnsResultOrder: "ipv4first",
      },
    });
    const resolverB = resolveTelegramFetchOrThrow(undefined, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "verbatim",
      },
    });

    await resolverA("https://api.telegram.org/botA/getMe");
    await resolverB("https://api.telegram.org/botB/getMe");

    const dispatcherA = getDispatcherFromUndiciCall(1);
    const dispatcherB = getDispatcherFromUndiciCall(2);

    expect(dispatcherA).toBeDefined();
    expect(dispatcherB).toBeDefined();
    expect(dispatcherA).not.toBe(dispatcherB);

    expect(dispatcherA?.options?.connect).toEqual(
      expect.objectContaining({
        autoSelectFamily: false,
      }),
    );
    expect(dispatcherB?.options?.connect).toEqual(
      expect.objectContaining({
        autoSelectFamily: true,
      }),
    );

    // Core guarantee: Telegram transport no longer mutates process-global defaults.
    expect(setGlobalDispatcher).not.toHaveBeenCalled();
    expect(setDefaultResultOrder).not.toHaveBeenCalled();
    expect(setDefaultAutoSelectFamily).not.toHaveBeenCalled();
  });
});
