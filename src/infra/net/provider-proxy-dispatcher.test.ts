import type { Dispatcher } from "undici";
import { describe, expect, it, vi } from "vitest";
import type { ModelsConfig } from "../../config/types.models.js";
import { buildProviderProxyRouter, ProviderProxyRouter } from "./provider-proxy-dispatcher.js";

vi.mock("../../logger.js", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
}));

function minimalProvider(baseUrl: string, proxy?: string) {
  return {
    baseUrl,
    proxy,
    models: [
      {
        id: "m",
        name: "m",
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ],
  };
}

describe("buildProviderProxyRouter", () => {
  it("returns undefined when no providers exist", () => {
    expect(buildProviderProxyRouter(undefined)).toBeUndefined();
    expect(buildProviderProxyRouter({})).toBeUndefined();
    expect(buildProviderProxyRouter({ providers: {} })).toBeUndefined();
  });

  it("returns undefined when no provider has a proxy field", () => {
    const cfg: ModelsConfig = {
      providers: {
        openai: minimalProvider("https://api.openai.com/v1"),
      },
    };
    expect(buildProviderProxyRouter(cfg)).toBeUndefined();
  });

  it('returns undefined when all providers use proxy: "env"', () => {
    const cfg: ModelsConfig = {
      providers: {
        openai: minimalProvider("https://api.openai.com/v1", "env"),
      },
    };
    expect(buildProviderProxyRouter(cfg)).toBeUndefined();
  });

  it('builds a router when a provider has proxy: "direct"', () => {
    const cfg: ModelsConfig = {
      providers: {
        local: minimalProvider("http://localhost:11434", "direct"),
      },
    };
    const router = buildProviderProxyRouter(cfg);
    expect(router).toBeInstanceOf(ProviderProxyRouter);
  });

  it("builds a router when a provider has a proxy URL", () => {
    const cfg: ModelsConfig = {
      providers: {
        custom: minimalProvider("https://api.example.com", "http://127.0.0.1:7890"),
      },
    };
    const router = buildProviderProxyRouter(cfg);
    expect(router).toBeInstanceOf(ProviderProxyRouter);
  });

  it("skips providers with unparseable baseUrl", () => {
    const cfg: ModelsConfig = {
      providers: {
        bad: minimalProvider("not-a-url", "direct"),
      },
    };
    expect(buildProviderProxyRouter(cfg)).toBeUndefined();
  });
});

describe("ProviderProxyRouter.dispatch", () => {
  function makeMockDispatcher() {
    const dispatchFn = vi.fn().mockReturnValue(true);
    const dispatcher = {
      dispatch: dispatchFn,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Dispatcher;
    return { dispatcher, dispatchFn };
  }

  it("routes to the matched hostname dispatcher", () => {
    const direct = makeMockDispatcher();
    const fb = makeMockDispatcher();
    const map = new Map<string, Dispatcher>([["api.pucode.com", direct.dispatcher]]);
    const router = new ProviderProxyRouter(map, fb.dispatcher, [direct.dispatcher]);

    const handler = {} as Dispatcher.DispatchHandler;
    router.dispatch(
      { origin: "https://api.pucode.com", path: "/v1/messages", method: "POST" },
      handler,
    );

    expect(direct.dispatchFn).toHaveBeenCalledTimes(1);
    expect(fb.dispatchFn).not.toHaveBeenCalled();
  });

  it("falls back for unmatched hostnames", () => {
    const direct = makeMockDispatcher();
    const fb = makeMockDispatcher();
    const map = new Map<string, Dispatcher>([["api.pucode.com", direct.dispatcher]]);
    const router = new ProviderProxyRouter(map, fb.dispatcher, [direct.dispatcher]);

    const handler = {} as Dispatcher.DispatchHandler;
    router.dispatch(
      { origin: "https://api.openai.com", path: "/v1/chat", method: "POST" },
      handler,
    );

    expect(direct.dispatchFn).not.toHaveBeenCalled();
    expect(fb.dispatchFn).toHaveBeenCalledTimes(1);
  });

  it("falls back when origin is missing", () => {
    const direct = makeMockDispatcher();
    const fb = makeMockDispatcher();
    const map = new Map<string, Dispatcher>([["example.com", direct.dispatcher]]);
    const router = new ProviderProxyRouter(map, fb.dispatcher, [direct.dispatcher]);

    const handler = {} as Dispatcher.DispatchHandler;
    router.dispatch(
      { path: "/v1/messages", method: "POST" } as Dispatcher.DispatchOptions,
      handler,
    );

    expect(fb.dispatchFn).toHaveBeenCalledTimes(1);
  });

  it("reuses dispatchers for the same proxy URL across different providers", () => {
    const cfg: ModelsConfig = {
      providers: {
        a: minimalProvider("https://api-a.example.com", "http://127.0.0.1:7890"),
        b: minimalProvider("https://api-b.example.com", "http://127.0.0.1:7890"),
      },
    };
    const router = buildProviderProxyRouter(cfg);
    expect(router).toBeInstanceOf(ProviderProxyRouter);
  });

  it("handles mixed proxy/direct/env providers", () => {
    const cfg: ModelsConfig = {
      providers: {
        proxied: minimalProvider("https://api.pucode.com", "http://127.0.0.1:12334"),
        direct: minimalProvider("http://localhost:11434", "direct"),
        default: minimalProvider("https://api.openai.com/v1"),
      },
    };
    const router = buildProviderProxyRouter(cfg);
    expect(router).toBeInstanceOf(ProviderProxyRouter);
  });
});
