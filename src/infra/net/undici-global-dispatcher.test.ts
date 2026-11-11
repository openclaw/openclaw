import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  Agent,
  EnvHttpProxyAgent,
  ManagedUndiciDispatcher: ManagedDispatcher,
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

  class EnvHttpProxyAgentLocal extends AgentLocal {}

  class ProxyAgentLocal extends AgentLocal {}

  class ManagedUndiciDispatcher {
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

  let currentDispatcher: unknown = new AgentLocal();

  const getGlobalDispatcher = vi.fn(() => currentDispatcher);
  const setGlobalDispatcherLocal = vi.fn((next: unknown) => {
    currentDispatcher = next;
  });
  const timeoutOptions = (timeoutMs?: number) =>
    timeoutMs ? { bodyTimeout: timeoutMs, headersTimeout: timeoutMs } : {};
  return {
    Agent: AgentLocal,
    EnvHttpProxyAgent: EnvHttpProxyAgentLocal,
    ManagedUndiciDispatcher,
    ProxyAgent: ProxyAgentLocal,
    setGlobalDispatcher: setGlobalDispatcherLocal,
    setCurrentDispatcher: (next: unknown) => {
      currentDispatcher = next;
    },
    getCurrentDispatcher: () => currentDispatcher,
    getDefaultAutoSelectFamily: vi.fn(() => undefined as boolean | undefined),
    setDefaultAutoSelectFamily: vi.fn(),
    isProxylineDispatcher: vi.fn(
      (dispatcher: unknown) => dispatcher instanceof ManagedUndiciDispatcher,
    ),
    createHttp1Agent: vi.fn(
      (options?: Record<string, unknown>, timeoutMs?: number) =>
        new AgentLocal({ ...options, ...timeoutOptions(timeoutMs), allowH2: false }),
    ),
    createHttp1EnvHttpProxyAgent: vi.fn(
      (options?: Record<string, unknown>, timeoutMs?: number) =>
        new EnvHttpProxyAgentLocal({
          ...options,
          ...timeoutOptions(timeoutMs),
          allowH2: false,
          clientFactory: "ip-safe-test-client-factory",
        }),
    ),
    loadUndiciGlobalDispatcherDeps: vi.fn(() => ({
      getGlobalDispatcher,
      setGlobalDispatcher: setGlobalDispatcherLocal,
    })),
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
let api: typeof import("./undici-global-dispatcher.js");
const DEFAULT_PROXY_OPTIONS = {
  httpProxy: "http://proxy.test:8080",
  httpsProxy: "http://proxy.test:8080",
};

beforeAll(async () => {
  api = await import("./undici-global-dispatcher.js");
});
beforeEach(() => {
  vi.clearAllMocks();
  api.resetGlobalUndiciStreamTimeoutsForTests();
  setCurrentDispatcher(new Agent());
  getDefaultAutoSelectFamily.mockReturnValue(undefined);
  vi.mocked(isWSL2Sync).mockReturnValue(false);
  vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue(undefined);
  vi.mocked(resolveEnvHttpProxyUrl).mockReturnValue(undefined);
});

type TimedDispatcher = InstanceType<typeof ManagedDispatcher> & {
  dispatch: (options: Record<string, unknown>, handler: Record<string, unknown>) => boolean;
};
const currentTimedDispatcher = () => getCurrentDispatcher() as TimedDispatcher;
const request = { origin: "https://example.test", path: "/", method: "GET" };
const timedRequest = (timeoutMs = 1_900_000) => ({
  ...request,
  bodyTimeout: timeoutMs,
  headersTimeout: timeoutMs,
  allowH2: false,
});
function installProxyDispatcher<T>(dispatcher: T, options = DEFAULT_PROXY_OPTIONS) {
  vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue(options);
  setCurrentDispatcher(dispatcher);
  return dispatcher;
}
function expectCurrentAgent(constructor: typeof Agent, options: Record<string, unknown>) {
  const next = getCurrentDispatcher() as InstanceType<typeof Agent>;
  expect(next).toBeInstanceOf(constructor);
  expect(next.options).toEqual(options);
}

describe("ensureGlobalUndiciDispatcherStreamTimeouts", () => {
  it("explicitly tunes the global dispatcher when requested for embedded attempts", () => {
    getDefaultAutoSelectFamily.mockReturnValue(false);

    api.ensureGlobalUndiciDispatcherStreamTimeouts({ timeoutMs: 1_900_000 });

    expect(loadUndiciGlobalDispatcherDeps).toHaveBeenCalledTimes(1);
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expectCurrentAgent(Agent, {
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
    setCurrentDispatcher(new ProxyAgent());

    api.ensureGlobalUndiciDispatcherStreamTimeouts({ timeoutMs: 1_900_000 });

    expect(setGlobalDispatcher).not.toHaveBeenCalled();
    expect(globalUndiciStreamTimeoutMs).toBe(1_900_000);
  });

  it("wraps Proxyline managed dispatcher with timed dispatch options", () => {
    const dispatcher = installProxyDispatcher(new ManagedDispatcher());

    api.ensureGlobalUndiciDispatcherStreamTimeouts({ timeoutMs: 1_900_000 });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const next = currentTimedDispatcher();
    expect(next).not.toBe(dispatcher);
    expect(next.constructor?.name).toBe("ManagedUndiciDispatcher");
    expect(next.on()).toBe(next);
    next.close();
    next.destroy();
    expect(dispatcher).toMatchObject({ closed: true, destroyed: true });
    expect(next.request(request)).toBe(true);
    expect(next.dispatch(request, {})).toBe(true);
    expect(dispatcher.requestCalls).toEqual([request]);
    expect(dispatcher.dispatchCalls).toEqual([
      { ...timedRequest(), fromRequest: true },
      timedRequest(),
    ]);
    expect(globalUndiciStreamTimeoutMs).toBe(1_900_000);
  });

  it("replaces a fresh Proxyline managed dispatcher after env proxy timeouts were applied", () => {
    installProxyDispatcher(new EnvHttpProxyAgent());
    api.ensureGlobalUndiciDispatcherStreamTimeouts({ timeoutMs: 1_900_000 });
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);

    const dispatcher = new ManagedDispatcher();
    setCurrentDispatcher(dispatcher);
    api.ensureGlobalUndiciDispatcherStreamTimeouts({ timeoutMs: 1_900_000 });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
    const next = currentTimedDispatcher();
    expect(next.constructor?.name).toBe("ManagedUndiciDispatcher");
    next.dispatch(request, {});
    expect(dispatcher.dispatchCalls).toEqual([timedRequest()]);
  });

  it("updates an existing Proxyline timeout wrapper when run timeout changes", () => {
    const dispatcher = installProxyDispatcher(new ManagedDispatcher());

    api.ensureGlobalUndiciDispatcherStreamTimeouts({ timeoutMs: 1_900_000 });
    const wrapped = getCurrentDispatcher();
    api.ensureGlobalUndiciDispatcherStreamTimeouts({ timeoutMs: 2_100_000 });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
    expect(getCurrentDispatcher()).toBe(wrapped);
    currentTimedDispatcher().dispatch(request, {});
    expect(dispatcher.dispatchCalls).toEqual([timedRequest(2_100_000)]);
  });

  it("temporarily applies the WSL2 family-selection policy around Proxyline dispatch", () => {
    getDefaultAutoSelectFamily.mockReturnValue(true);
    vi.mocked(isWSL2Sync).mockReturnValue(true);
    const dispatcher = installProxyDispatcher(new ManagedDispatcher());

    api.ensureGlobalUndiciDispatcherStreamTimeouts({ timeoutMs: 1_900_000 });

    currentTimedDispatcher().dispatch(request, {});
    expect(setDefaultAutoSelectFamily).toHaveBeenNthCalledWith(1, false);
    expect(setDefaultAutoSelectFamily).toHaveBeenNthCalledWith(2, true);
    expect(dispatcher.dispatchCalls).toEqual([timedRequest()]);
  });

  it("is idempotent for unchanged dispatcher kind and network policy", () => {
    getDefaultAutoSelectFamily.mockReturnValue(true);
    installProxyDispatcher(new EnvHttpProxyAgent());

    api.ensureGlobalUndiciDispatcherStreamTimeouts();
    api.ensureGlobalUndiciDispatcherStreamTimeouts();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
  });
});

describe("ensureGlobalUndiciEnvProxyDispatcher", () => {
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
      api.ensureGlobalUndiciEnvProxyDispatcher();

      expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
      expectCurrentAgent(EnvHttpProxyAgent, {
        httpProxy: "https://proxy.example:8443",
        httpsProxy,
        allowH2: false,
        clientFactory: "ip-safe-test-client-factory",
      });
      api.ensureGlobalUndiciEnvProxyDispatcher();
      expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
      stopActiveManagedProxyRegistration(registration);
      registration = registerActiveManagedProxyUrl(new URL("https://proxy.example:8443"), {
        proxyTls: { ca: "replaced-bootstrap-ca" },
      });
      api.ensureGlobalUndiciEnvProxyDispatcher();
      expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
    } finally {
      stopActiveManagedProxyRegistration(registration);
    }
  });

  it("retries proxy bootstrap after an unsupported dispatcher later becomes a default Agent", () => {
    installProxyDispatcher(new ProxyAgent());

    api.ensureGlobalUndiciEnvProxyDispatcher();
    expect(setGlobalDispatcher).not.toHaveBeenCalled();

    setCurrentDispatcher(new Agent());
    api.ensureGlobalUndiciEnvProxyDispatcher();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(getCurrentDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
  });
});

describe("forceResetGlobalDispatcher", () => {
  it("does not import undici when proxy env is cleared", () => {
    setCurrentDispatcher(new EnvHttpProxyAgent());

    api.forceResetGlobalDispatcher();

    expect(loadUndiciGlobalDispatcherDeps).not.toHaveBeenCalled();
    expect(setGlobalDispatcher).not.toHaveBeenCalled();
  });

  it("restores a direct Agent when clearing a proxy dispatcher installed by OpenClaw", () => {
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue(DEFAULT_PROXY_OPTIONS);
    api.ensureGlobalUndiciEnvProxyDispatcher();
    expect(getCurrentDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);

    vi.clearAllMocks();
    vi.mocked(resolveEnvHttpProxyAgentOptions).mockReturnValue(undefined);

    api.forceResetGlobalDispatcher();

    expect(loadUndiciGlobalDispatcherDeps).toHaveBeenCalledTimes(1);
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expectCurrentAgent(Agent, { allowH2: false });
  });

  it("replaces a stale EnvHttpProxyAgent when restored proxy env is still configured", () => {
    installProxyDispatcher(new EnvHttpProxyAgent());

    api.forceResetGlobalDispatcher();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expectCurrentAgent(EnvHttpProxyAgent, {
      ...DEFAULT_PROXY_OPTIONS,
      allowH2: false,
      clientFactory: "ip-safe-test-client-factory",
    });
  });

  it.each(["bootstrap", "reset"])("preserves Proxyline during %s", (operation) => {
    const dispatcher = installProxyDispatcher(new ManagedDispatcher());
    if (operation === "bootstrap") {
      api.ensureGlobalUndiciEnvProxyDispatcher();
    } else {
      api.forceResetGlobalDispatcher({ preserveProxylineManaged: true });
    }

    expect(setGlobalDispatcher).not.toHaveBeenCalled();
    expect(getCurrentDispatcher()).toBe(dispatcher);
  });
});

afterAll(() => {
  for (const id of mockedModuleIds) {
    vi.doUnmock(id);
  }
});
