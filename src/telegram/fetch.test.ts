import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveFetch } from "../infra/fetch.js";
import { resetTelegramFetchStateForTests, resolveTelegramFetch } from "./fetch.js";

const setDefaultAutoSelectFamily = vi.hoisted(() => vi.fn());
const setDefaultResultOrder = vi.hoisted(() => vi.fn());
const setGlobalDispatcher = vi.hoisted(() => vi.fn());
const AgentCtor = vi.hoisted(() =>
  vi.fn(function MockAgent(this: { options: unknown }, options: unknown) {
    this.options = options;
  }),
);
const EnvProxyAgentCtor = vi.hoisted(() =>
  vi.fn(function MockEnvProxyAgent(this: { options?: unknown }, options?: unknown) {
    this.options = options;
  }),
);
const undiciFetch = vi.hoisted(() => vi.fn(async () => ({}) as Response));

vi.mock("node:net", async () => {
  const actual = await vi.importActual<typeof import("node:net")>("node:net");
  return {
    ...actual,
    setDefaultAutoSelectFamily,
  };
});

vi.mock("node:dns", async () => {
  const actual = await vi.importActual<typeof import("node:dns")>("node:dns");
  return {
    ...actual,
    setDefaultResultOrder,
  };
});

vi.mock("undici", () => ({
  Agent: AgentCtor,
  EnvHttpProxyAgent: EnvProxyAgentCtor,
  fetch: undiciFetch,
  setGlobalDispatcher,
}));

const originalFetch = globalThis.fetch;

afterEach(() => {
  resetTelegramFetchStateForTests();
  setDefaultAutoSelectFamily.mockReset();
  setDefaultResultOrder.mockReset();
  setGlobalDispatcher.mockReset();
  AgentCtor.mockClear();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  } else {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  }
});

describe("resolveTelegramFetch", () => {
  it("returns wrapped global fetch when available", async () => {
    const fetchMock = vi.fn(async () => ({}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const resolved = resolveTelegramFetch();

    expect(resolved).toBeTypeOf("function");
    expect(resolved).not.toBe(fetchMock);
  });

  it("wraps proxy fetches and normalizes foreign signals once", async () => {
    let seenSignal: AbortSignal | undefined;
    const proxyFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenSignal = init?.signal as AbortSignal | undefined;
      return {} as Response;
    });

    const resolved = resolveTelegramFetch(proxyFetch as unknown as typeof fetch);
    expect(resolved).toBeTypeOf("function");

    let abortHandler: (() => void) | null = null;
    const addEventListener = vi.fn((event: string, handler: () => void) => {
      if (event === "abort") {
        abortHandler = handler;
      }
    });
    const removeEventListener = vi.fn((event: string, handler: () => void) => {
      if (event === "abort" && abortHandler === handler) {
        abortHandler = null;
      }
    });
    const fakeSignal = {
      aborted: false,
      addEventListener,
      removeEventListener,
    } as unknown as AbortSignal;

    if (!resolved) {
      throw new Error("expected resolved proxy fetch");
    }
    await resolved("https://example.com", { signal: fakeSignal });

    expect(proxyFetch).toHaveBeenCalledOnce();
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal).not.toBe(fakeSignal);
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledTimes(1);
  });

  it("does not double-wrap an already wrapped proxy fetch", async () => {
    const proxyFetch = vi.fn(async () => ({ ok: true }) as Response) as unknown as typeof fetch;
    const alreadyWrapped = resolveFetch(proxyFetch);

    const resolved = resolveTelegramFetch(alreadyWrapped);

    expect(resolved).toBe(alreadyWrapped);
  });

  it("honors env enable override", async () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY", "1");
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch();
    expect(setDefaultAutoSelectFamily).toHaveBeenCalledWith(true);
  });

  it("uses config override when provided", async () => {
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });
    expect(setDefaultAutoSelectFamily).toHaveBeenCalledWith(true);
  });

  it("env disable override wins over config", async () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY", "0");
    vi.stubEnv("OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY", "1");
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });
    expect(setDefaultAutoSelectFamily).toHaveBeenCalledWith(false);
  });

  it("applies dns result order from config", async () => {
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch(undefined, { network: { dnsResultOrder: "verbatim" } });
    expect(setDefaultResultOrder).toHaveBeenCalledWith("verbatim");
  });

  it("retries dns setter on next call when previous attempt threw", async () => {
    setDefaultResultOrder.mockImplementationOnce(() => {
      throw new Error("dns setter failed once");
    });
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;

    resolveTelegramFetch(undefined, { network: { dnsResultOrder: "ipv4first" } });
    resolveTelegramFetch(undefined, { network: { dnsResultOrder: "ipv4first" } });

    expect(setDefaultResultOrder).toHaveBeenCalledTimes(2);
  });

  it("replaces global undici dispatcher with autoSelectFamily-enabled agent", async () => {
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(AgentCtor).toHaveBeenCalledWith({
      connect: {
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
      },
    });
  });

  it("sets global dispatcher only once across repeated equal decisions", async () => {
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
  });

  it("updates global dispatcher when autoSelectFamily decision changes", async () => {
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: false } });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
    expect(AgentCtor).toHaveBeenNthCalledWith(1, {
      connect: {
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
      },
    });
    expect(AgentCtor).toHaveBeenNthCalledWith(2, {
      connect: {
        autoSelectFamily: false,
        autoSelectFamilyAttemptTimeout: 300,
      },
    });
  });

  it("uses EnvHttpProxyAgent-based fetch when HTTP_PROXY is configured and no explicit proxy fetch", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    // Ensure we don't rely on global fetch path when env proxy is set.
    delete (globalThis as { fetch?: typeof fetch }).fetch;

    const resolved = resolveTelegramFetch();
    expect(resolved).toBeTypeOf("function");

    if (!resolved) {
      throw new Error("expected resolved env proxy fetch");
    }

    await resolved("https://api.telegram.org/bot123/getMe");

    expect(EnvProxyAgentCtor).toHaveBeenCalledTimes(1);
    expect(undiciFetch).toHaveBeenCalledTimes(1);
    const call = undiciFetch.mock.calls[0] as unknown[];
    expect(call[0]).toBe("https://api.telegram.org/bot123/getMe");
    const init = call[1] as { dispatcher?: unknown } | undefined;
    expect(init?.dispatcher).toBeInstanceOf(EnvProxyAgentCtor);
  });
});
