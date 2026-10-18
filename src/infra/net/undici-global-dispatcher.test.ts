// Covers global Undici dispatcher policy: proxy bootstrap, stream timeouts,
// WSL2 address-family handling, and managed-dispatcher wrapping.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  Agent,
  EnvHttpProxyAgent,
  ManagedUndiciDispatcher,
  ProxyAgent,
  setGlobalDispatcher,
  setCurrentDispatcher,
  getCurrentDispatcher,
  getDefaultAutoSelectFamily,
  setDefaultAutoSelectFamily,
  isProxylineDispatcher,
  createHttp1Agent,
  createHttp1EnvHttpProxyAgent,
  loadUndiciGlobalDispatcherDeps,
} = vi.hoisted(() => {
  class AgentLocal {
    constructor(public readonly options?: Record<string, unknown>) {}
  }

  class EnvHttpProxyAgentLocal {
    constructor(public readonly options?: Record<string, unknown>) {}
  }

  class ProxyAgentLocal {
    constructor(public readonly url: string) {}
  }

  class ManagedUndiciDispatcherLocal {
    #closed = false;
    #destroyed = false;
    public readonly dispatchCalls: Array<Record<string, unknown>> = [];
    public readonly requestCalls: Array<Record<string, unknown>> = [];
    get closed(): boolean {
      return this.#closed;
    }
    get destroyed(): boolean {
      return this.#destroyed;
    }
    dispatch(options: Record<string, unknown>): boolean {
      this.dispatchCalls.push(options);
      return true;
    }
    request(options: Record<string, unknown>): boolean {
      this.requestCalls.push(options);
      return this.dispatch({ ...options, fromRequest: true });
    }
    on(): this {
      return this;
    }
    close(): void {
      this.#closed = true;
    }
    destroy(): void {
      this.#destroyed = true;
    }
  }
  Object.defineProperty(ManagedUndiciDispatcherLocal, "name", {
    value: "ManagedUndiciDispatcher",
  });

  let currentDispatcher: unknown = new AgentLocal();

  const getGlobalDispatcher = vi.fn(() => currentDispatcher);
  const setGlobalDispatcherLocal = vi.fn((next: unknown) => {
    currentDispatcher = next;
  });
  const setCurrentDispatcherLocal = (next: unknown) => {
    currentDispatcher = next;
  };
  const getCurrentDispatcherLocal = () => currentDispatcher;
  const getDefaultAutoSelectFamilyLocal = vi.fn(() => undefined as boolean | undefined);
  const setDefaultAutoSelectFamilyLocal = vi.fn();
  const isProxylineDispatcherLocal = vi.fn(
    (dispatcher: unknown) => dispatcher instanceof ManagedUndiciDispatcherLocal,
  );
  const createHttp1AgentLocal = vi.fn(
    (options?: Record<string, unknown>, timeoutMs?: number) =>
      new AgentLocal({
        ...options,
        ...(timeoutMs ? { bodyTimeout: timeoutMs, headersTimeout: timeoutMs } : {}),
        allowH2: false,
      }),
  );
  const createHttp1EnvHttpProxyAgentLocal = vi.fn(
    (options?: Record<string, unknown>, timeoutMs?: number) =>
      new EnvHttpProxyAgentLocal({
        ...options,
        ...(timeoutMs ? { bodyTimeout: timeoutMs, headersTimeout: timeoutMs } : {}),
        allowH2: false,
        clientFactory: "ip-safe-test-client-factory",
      }),
  );
  const loadUndiciGlobalDispatcherDepsLocal = vi.fn(() => ({
    Agent: AgentLocal,
    EnvHttpProxyAgent: EnvHttpProxyAgentLocal,
    getGlobalDispatcher,
    setGlobalDispatcher: setGlobalDispatcherLocal,
  }));

  return {
    Agent: AgentLocal,
    EnvHttpProxyAgent: EnvHttpProxyAgentLocal,
    ManagedUndiciDispatcher: ManagedUndiciDispatcherLocal,
    ProxyAgent: ProxyAgentLocal,
    setGlobalDispatcher: setGlobalDispatcherLocal,
    setCurrentDispatcher: setCurrentDispatcherLocal,
    getCurrentDispatcher: getCurrentDispatcherLocal,
    getDefaultAutoSelectFamily: getDefaultAutoSelectFamilyLocal,
    isProxylineDispatcher: isProxylineDispatcherLocal,
    createHttp1Agent: createHttp1AgentLocal,
    createHttp1EnvHttpProxyAgent: createHttp1EnvHttpProxyAgentLocal,
    setDefaultAutoSelectFamily: setDefaultAutoSelectFamilyLocal,
    loadUndiciGlobalDispatcherDeps: loadUndiciGlobalDispatcherDepsLocal,
  };
});

const mockedModuleIds = [
  "@openclaw/proxyline/dispatcher-brand",
  "node:net",
  "./proxy-env.js",
  "./undici-runtime.js",
  "../wsl.js",
] as const;

vi.mock("@openclaw/proxyline/dispatcher-brand", () => ({
  isProxylineDispatcher,
}));

vi.mock("node:net", () => ({
  getDefaultAutoSelectFamily,
  setDefaultAutoSelectFamily,
}));

// mock-isolation: dispatcher policy uses fixture proxy settings, not the host environment.
vi.mock("./proxy-env.js", () => ({
  resolveEnvHttpProxyAgentOptions: vi.fn(() => undefined),
  resolveEnvHttpProxyUrl: vi.fn(() => undefined),
}));

vi.mock("./undici-runtime.js", () => ({
  createHttp1Agent,
  createHttp1EnvHttpProxyAgent,
  loadUndiciGlobalDispatcherDeps,
}));

vi.mock("../wsl.js", () => ({
  isWSL2Sync: vi.fn(() => false),
}));

import { isWSL2Sync } from "../wsl.js";
import { resolveEnvHttpProxyAgentOptions, resolveEnvHttpProxyUrl } from "./proxy-env.js";
import {
  registerActiveManagedProxyUrl,
  stopActiveManagedProxyRegistration,
} from "./proxy/active-proxy-state.js";
import { globalUndiciStreamTimeoutMs } from "./undici-dispatcher-options.js";
let ensureGlobalUndiciDispatcherStreamTimeouts: typeof import("./undici-global-dispatcher.js").ensureGlobalUndiciDispatcherStreamTimeouts;
let ensureGlobalUndiciEnvProxyDispatcher: typeof import("./undici-global-dispatcher.js").ensureGlobalUndiciEnvProxyDispatcher;
let forceResetGlobalDispatcher: typeof import("./undici-global-dispatcher.js").forceResetGlobalDispatcher;
let resetGlobalUndiciStreamTimeoutsForTests: typeof import("./undici-global-dispatcher.js").resetGlobalUndiciStreamTimeoutsForTests;
let undiciGlobalDispatcherModule: typeof import("./undici-global-dispatcher.js");
const DEFAULT_PROXY_OPTIONS = {
  httpProxy: "http://proxy.test:8080",
  httpsProxy: "http://proxy.test:8080",
};

describe("ensureGlobalUndiciDispatcherStreamTimeouts", () => {
  beforeAll(async () => {
    undiciGlobalDispatcherModule = await import("./undici-global-dispatcher.js");
    ({
      ensureGlobalUndiciDispatcherStreamTimeouts,
      ensureGlobalUndiciEnvProxyDispatcher,
      forceResetGlobalDispatcher,
      resetGlobalUndiciStreamTimeoutsForTests,
    } = undiciGlobalDispatcherModule);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetGlobalUndiciStreamTimeoutsForTests();
    setCurrentDispatcher(new Agent());
    getDefaultAutoSelectFamily.mockReturnValue(undefined);
    vi.mocked(isWSL2Sync).mockReturnValue(false);
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue(undefined);
    vi.mocked(resolveEnvHttpProxyUrl).mockReturnValue(undefined);
  });

  it("explicitly tunes the global dispatcher when requested for embedded attempts", () => {
    getDefaultAutoSelectFamily.mockReturnValue(false);

    ensureGlobalUndiciDispatcherStreamTimeouts({ timeoutMs: 1_900_000 });

    expect(loadUndiciGlobalDispatcherDeps).toHaveBeenCalledTimes(1);
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const next = getCurrentDispatcher() as { options?: Record<string, unknown> };
    expect(next).toBeInstanceOf(Agent);
    expect(next.options).toEqual({
      bodyTimeout: 1_900_000,
      headersTimeout: 1_900_000,
      allowH2: false,
      connect: {
        autoSelectFamily: false,
        autoSelectFamilyAttemptTimeout: 300,
      },
    });
    expect(globalUndiciStreamTimeoutMs).toBe(1_900_000);
  });

  it("records timeout bridge but does not override unsupported custom proxy dispatcher types", () => {
    setCurrentDispatcher(new ProxyAgent("http://proxy.test:8080"));

    ensureGlobalUndiciDispatcherStreamTimeouts({ timeoutMs: 1_900_000 });

    expect(setGlobalDispatcher).not.toHaveBeenCalled();
    expect(globalUndiciStreamTimeoutMs).toBe(1_900_000);
  });

  it("wraps Proxyline managed dispatcher with timed dispatch options", () => {
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue(DEFAULT_PROXY_OPTIONS);
    const dispatcher = new ManagedUndiciDispatcher();
    setCurrentDispatcher(dispatcher);

    ensureGlobalUndiciDispatcherStreamTimeouts({ timeoutMs: 1_900_000 });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const next = getCurrentDispatcher() as {
      constructor?: { name?: string };
      dispatch: (options: Record<string, unknown>, handler: Record<string, unknown>) => boolean;
      on: () => unknown;
      request: (options: Record<string, unknown>) => boolean;
      close: () => void;
      destroy: () => void;
    };
    expect(next).not.toBe(dispatcher);
    expect(next.constructor?.name).toBe("ManagedUndiciDispatcher");
    expect(next.on()).toBe(next);
    next.close();
    next.destroy();
    expect(dispatcher.closed).toBe(true);
    expect(dispatcher.destroyed).toBe(true);
    expect(next.request({ origin: "https://request.example.test", path: "/", method: "GET" })).toBe(
      true,
    );
    expect(next.dispatch({ origin: "https://example.test", path: "/", method: "GET" }, {})).toBe(
      true,
    );
    expect(dispatcher.requestCalls).toEqual([
      {
        origin: "https://request.example.test",
        path: "/",
        method: "GET",
      },
    ]);
    expect(dispatcher.dispatchCalls).toEqual([
      {
        origin: "https://request.example.test",
        path: "/",
        method: "GET",
        fromRequest: true,
        bodyTimeout: 1_900_000,
        headersTimeout: 1_900_000,
        allowH2: false,
      },
      {
        origin: "https://example.test",
        path: "/",
        method: "GET",
        bodyTimeout: 1_900_000,
        headersTimeout: 1_900_000,
        allowH2: false,
      },
    ]);
    expect(globalUndiciStreamTimeoutMs).toBe(1_900_000);
  });

  it("replaces a fresh Proxyline managed dispatcher after env proxy timeouts were applied", () => {
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue({
      httpProxy: "http://proxyline.example:3128",
      httpsProxy: "http://proxyline.example:3128",
    });
    setCurrentDispatcher(new EnvHttpProxyAgent());
    ensureGlobalUndiciDispatcherStreamTimeouts({ timeoutMs: 1_900_000 });
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);

    const dispatcher = new ManagedUndiciDispatcher();
    setCurrentDispatcher(dispatcher);
    ensureGlobalUndiciDispatcherStreamTimeouts({ timeoutMs: 1_900_000 });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
    const next = getCurrentDispatcher() as {
      constructor?: { name?: string };
      dispatch: (options: Record<string, unknown>, handler: Record<string, unknown>) => boolean;
    };
    expect(next.constructor?.name).toBe("ManagedUndiciDispatcher");
    next.dispatch({ origin: "https://example.test", path: "/", method: "GET" }, {});
    expect(dispatcher.dispatchCalls).toEqual([
      {
        origin: "https://example.test",
        path: "/",
        method: "GET",
        bodyTimeout: 1_900_000,
        headersTimeout: 1_900_000,
        allowH2: false,
      },
    ]);
  });

  it("updates an existing Proxyline timeout wrapper when run timeout changes", () => {
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue(DEFAULT_PROXY_OPTIONS);
    const dispatcher = new ManagedUndiciDispatcher();
    setCurrentDispatcher(dispatcher);

    ensureGlobalUndiciDispatcherStreamTimeouts({ timeoutMs: 1_900_000 });
    const wrapped = getCurrentDispatcher();
    ensureGlobalUndiciDispatcherStreamTimeouts({ timeoutMs: 2_100_000 });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
    expect(getCurrentDispatcher()).toBe(wrapped);
    const next = getCurrentDispatcher() as {
      dispatch: (options: Record<string, unknown>, handler: Record<string, unknown>) => boolean;
    };
    next.dispatch({ origin: "https://example.test", path: "/", method: "GET" }, {});
    expect(dispatcher.dispatchCalls).toEqual([
      {
        origin: "https://example.test",
        path: "/",
        method: "GET",
        bodyTimeout: 2_100_000,
        headersTimeout: 2_100_000,
        allowH2: false,
      },
    ]);
  });

  it("temporarily applies the WSL2 family-selection policy around Proxyline dispatch", () => {
    getDefaultAutoSelectFamily.mockReturnValue(true);
    vi.mocked(isWSL2Sync).mockReturnValue(true);
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue(DEFAULT_PROXY_OPTIONS);
    const dispatcher = new ManagedUndiciDispatcher();
    setCurrentDispatcher(dispatcher);

    ensureGlobalUndiciDispatcherStreamTimeouts({ timeoutMs: 1_900_000 });

    const next = getCurrentDispatcher() as {
      dispatch: (options: Record<string, unknown>, handler: Record<string, unknown>) => boolean;
    };
    next.dispatch({ origin: "https://example.test", path: "/", method: "GET" }, {});
    expect(setDefaultAutoSelectFamily).toHaveBeenNthCalledWith(1, false);
    expect(setDefaultAutoSelectFamily).toHaveBeenNthCalledWith(2, true);
    expect(dispatcher.dispatchCalls).toEqual([
      {
        origin: "https://example.test",
        path: "/",
        method: "GET",
        bodyTimeout: 1_900_000,
        headersTimeout: 1_900_000,
        allowH2: false,
      },
    ]);
  });

  it("is idempotent for unchanged dispatcher kind and network policy", () => {
    getDefaultAutoSelectFamily.mockReturnValue(true);
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue(DEFAULT_PROXY_OPTIONS);
    setCurrentDispatcher(new EnvHttpProxyAgent());

    ensureGlobalUndiciDispatcherStreamTimeouts();
    ensureGlobalUndiciDispatcherStreamTimeouts();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
  });
});

describe("ensureGlobalUndiciEnvProxyDispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGlobalUndiciStreamTimeoutsForTests();
    setCurrentDispatcher(new Agent());
    vi.mocked(isWSL2Sync).mockReturnValue(false);
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue(undefined);
    vi.mocked(resolveEnvHttpProxyUrl).mockReturnValue(undefined);
  });

  it("rebuilds the env dispatcher when active managed CA trust changes beside a SOCKS proxy", () => {
    const httpsProxy = "socks5://proxy.test:1080";
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue({
      httpProxy: "https://proxy.example:8443",
      httpsProxy,
    });
    let registration = registerActiveManagedProxyUrl(new URL("https://proxy.example:8443"), {
      proxyTls: { ca: "bootstrap-ca" },
    });

    try {
      ensureGlobalUndiciEnvProxyDispatcher();

      expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
      const next = getCurrentDispatcher() as { options?: Record<string, unknown> };
      expect(next).toBeInstanceOf(EnvHttpProxyAgent);
      expect(next.options).toEqual({
        httpProxy: "https://proxy.example:8443",
        httpsProxy,
        allowH2: false,
        clientFactory: "ip-safe-test-client-factory",
      });
      ensureGlobalUndiciEnvProxyDispatcher();
      expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
      stopActiveManagedProxyRegistration(registration);
      registration = registerActiveManagedProxyUrl(new URL("https://proxy.example:8443"), {
        proxyTls: { ca: "replaced-bootstrap-ca" },
      });
      ensureGlobalUndiciEnvProxyDispatcher();
      expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
    } finally {
      stopActiveManagedProxyRegistration(registration);
    }
  });

  it("treats Proxyline managed dispatchers as already proxy-backed during bootstrap", () => {
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue(DEFAULT_PROXY_OPTIONS);
    setCurrentDispatcher(new ManagedUndiciDispatcher());

    ensureGlobalUndiciEnvProxyDispatcher();

    expect(setGlobalDispatcher).not.toHaveBeenCalled();
  });

  it("retries proxy bootstrap after an unsupported dispatcher later becomes a default Agent", () => {
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue(DEFAULT_PROXY_OPTIONS);
    setCurrentDispatcher(new ProxyAgent("http://proxy.test:8080"));

    ensureGlobalUndiciEnvProxyDispatcher();
    expect(setGlobalDispatcher).not.toHaveBeenCalled();

    setCurrentDispatcher(new Agent());
    ensureGlobalUndiciEnvProxyDispatcher();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(getCurrentDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
  });
});

describe("forceResetGlobalDispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGlobalUndiciStreamTimeoutsForTests();
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue(undefined);
    vi.mocked(resolveEnvHttpProxyUrl).mockReturnValue(undefined);
    vi.mocked(isWSL2Sync).mockReturnValue(false);
  });

  it("does not import undici when proxy env is cleared", () => {
    setCurrentDispatcher(new EnvHttpProxyAgent());

    forceResetGlobalDispatcher();

    expect(loadUndiciGlobalDispatcherDeps).not.toHaveBeenCalled();
    expect(setGlobalDispatcher).not.toHaveBeenCalled();
  });

  it("restores a direct Agent when clearing a proxy dispatcher installed by OpenClaw", () => {
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue(DEFAULT_PROXY_OPTIONS);
    ensureGlobalUndiciEnvProxyDispatcher();
    expect(getCurrentDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);

    vi.clearAllMocks();
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue(undefined);

    forceResetGlobalDispatcher();

    expect(loadUndiciGlobalDispatcherDeps).toHaveBeenCalledTimes(1);
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(getCurrentDispatcher()).toBeInstanceOf(Agent);
    expect((getCurrentDispatcher() as { options?: Record<string, unknown> }).options).toEqual({
      allowH2: false,
    });
  });

  it("replaces a stale EnvHttpProxyAgent when restored proxy env is still configured", () => {
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue({
      httpProxy: "http://proxy-b.example:8080",
      httpsProxy: "http://proxy-b.example:8080",
    });
    setCurrentDispatcher(new EnvHttpProxyAgent());

    forceResetGlobalDispatcher();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(getCurrentDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
    expect((getCurrentDispatcher() as { options?: Record<string, unknown> }).options).toEqual({
      httpProxy: "http://proxy-b.example:8080",
      httpsProxy: "http://proxy-b.example:8080",
      allowH2: false,
      clientFactory: "ip-safe-test-client-factory",
    });
  });

  it("preserves Proxyline managed dispatcher when requested", () => {
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue({
      httpProxy: "http://proxy-a.example:8080",
      httpsProxy: "http://proxy-a.example:8080",
    });
    const dispatcher = new ManagedUndiciDispatcher();
    setCurrentDispatcher(dispatcher);

    forceResetGlobalDispatcher({ preserveProxylineManaged: true });

    expect(setGlobalDispatcher).not.toHaveBeenCalled();
    expect(getCurrentDispatcher()).toBe(dispatcher);
  });
});

afterAll(() => {
  for (const id of mockedModuleIds) {
    vi.doUnmock(id);
  }
});
