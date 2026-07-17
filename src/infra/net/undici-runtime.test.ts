// Undici runtime tests cover managed proxy TLS, IP-SNI stripping, and proxy
// client factory installation.
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerActiveManagedProxyUrl,
  stopActiveManagedProxyRegistration,
} from "./proxy/active-proxy-state.js";
import {
  createHttp1Agent,
  createHttp1EnvHttpProxyAgent,
  createHttp1ProxyAgent,
} from "./undici-runtime.js";

const logDebug = vi.hoisted(() => vi.fn());

vi.mock("../../logger.js", () => ({ logDebug }));

const envHttpProxyAgentCtor = vi.fn();
const poolCtor = vi.fn();
const proxyAgentCtor = vi.fn();
const proxyConnect = vi.fn();
const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";

afterEach(() => {
  Reflect.deleteProperty(globalThis as object, TEST_UNDICI_RUNTIME_DEPS_KEY);
  envHttpProxyAgentCtor.mockReset();
  poolCtor.mockReset();
  proxyAgentCtor.mockReset();
  proxyConnect.mockReset();
  logDebug.mockReset();
});

class MockClient extends EventEmitter {
  constructor(
    public readonly origin: unknown,
    public readonly options: unknown,
  ) {
    super();
  }
}

class MockAgent extends EventEmitter {
  readonly __testStub = true;

  constructor(public readonly options?: Record<string, unknown>) {
    super();
  }

  createOriginDispatcher(options: Record<string, unknown>): EventEmitter {
    const factory = this.options?.factory;
    if (typeof factory === "function") {
      return factory(new URL("https://service.test"), options) as EventEmitter;
    }
    return options.connections === 1
      ? new MockClient(new URL("https://service.test"), options)
      : new MockPool(new URL("https://service.test"), options);
  }
}

class MockPool extends EventEmitter {
  readonly __testStub = true;

  constructor(
    public readonly origin: unknown,
    public readonly options: unknown,
  ) {
    super();
    poolCtor(origin, options);
  }

  createClient(): EventEmitter {
    const options = expectOptionsRecord(this.options, "expected Pool options object");
    const factory = options.factory;
    return typeof factory === "function"
      ? (factory(this.origin, options) as EventEmitter)
      : new MockClient(this.origin, options);
  }
}

class MockEnvHttpProxyAgent extends EventEmitter {
  readonly __testStub = true;

  constructor(public readonly options: unknown) {
    super();
    envHttpProxyAgentCtor(options);
  }
}

class MockProxyAgent extends EventEmitter {
  readonly __testStub = true;

  constructor(public readonly options: unknown) {
    super();
    proxyAgentCtor(options);
  }
}

function installUndiciRuntimeDeps(): void {
  (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
    Agent: MockAgent,
    Client: MockClient,
    EnvHttpProxyAgent: MockEnvHttpProxyAgent,
    Pool: MockPool,
    ProxyAgent: MockProxyAgent,
    fetch: vi.fn(),
  };
}

function createProxyClientFromOptions(options: Record<string, unknown>): EventEmitter {
  const clientFactory = options.clientFactory;
  if (typeof clientFactory !== "function") {
    throw new Error("expected ProxyAgent clientFactory");
  }
  const pool = clientFactory(new URL("https://service.test"), {
    connect: proxyConnect,
  }) as MockPool;
  return pool.createClient();
}

function expectOptionsRecord(options: unknown, message: string): Record<string, unknown> {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new Error(message);
  }
  return options as Record<string, unknown>;
}

function requireProxyAgentOptions(): Record<string, unknown> {
  const call = proxyAgentCtor.mock.calls[0];
  if (!call) {
    throw new Error("expected ProxyAgent constructor call");
  }
  return expectOptionsRecord(call[0], "expected ProxyAgent options object");
}

function requireEnvHttpProxyAgentOptions(): Record<string, unknown> {
  const call = envHttpProxyAgentCtor.mock.calls[0];
  if (!call) {
    throw new Error("expected EnvHttpProxyAgent constructor call");
  }
  return expectOptionsRecord(call[0], "expected EnvHttpProxyAgent options object");
}

function requireClientOptions(): Record<string, unknown> {
  const call = poolCtor.mock.calls[0];
  if (!call) {
    throw new Error("expected Pool constructor call");
  }
  return expectOptionsRecord(call[1], "expected Pool options object");
}

function invokeProxyClientFactory(options: Record<string, unknown>): void {
  const clientFactory = options.clientFactory;
  if (typeof clientFactory !== "function") {
    throw new Error("expected ProxyAgent clientFactory");
  }
  clientFactory(new URL("https://127.0.0.1:8443"), { connect: proxyConnect });
}

describe("undici dispatcher errors", () => {
  it.each([
    {
      name: "direct agent client",
      createClient: () => {
        const agent = createHttp1Agent() as unknown as MockAgent;
        return agent.createOriginDispatcher({ connections: 1 });
      },
    },
    {
      name: "explicit proxy client",
      createClient: () => {
        createHttp1ProxyAgent({ uri: "http://proxy.test:8080" });
        return createProxyClientFromOptions(requireProxyAgentOptions());
      },
    },
    {
      name: "environment proxy client",
      createClient: () => {
        createHttp1EnvHttpProxyAgent({ httpsProxy: "http://proxy.test:8080" });
        return createProxyClientFromOptions(requireEnvHttpProxyAgentOptions());
      },
    },
  ])("handles an internal error from $name", ({ createClient }) => {
    installUndiciRuntimeDeps();
    const client = createClient();
    const error = new Error("stream handler aborted");

    expect(() => client.emit("error", error)).not.toThrow();
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining(error.message));
  });
});

function invokeClientConnect(options: Record<string, unknown>, servername: string): void {
  const connect = options.connect;
  if (typeof connect !== "function") {
    throw new Error("expected wrapped Client connect");
  }
  connect({ host: "127.0.0.1:8443", servername }, vi.fn());
}

describe("createHttp1ProxyAgent", () => {
  it("adds active managed proxy CA trust to explicit ProxyAgent options", () => {
    installUndiciRuntimeDeps();
    const registration = registerActiveManagedProxyUrl(new URL("https://proxy.test:8443"), {
      proxyTls: { ca: "explicit-proxy-agent-ca" },
    });

    try {
      createHttp1ProxyAgent({ uri: "https://proxy.test:8443" });

      const options = requireProxyAgentOptions();
      expect(options.uri).toBe("https://proxy.test:8443");
      expect(options.allowH2).toBe(false);
      expect(options.proxyTls).toMatchObject({ ca: "explicit-proxy-agent-ca" });
    } finally {
      stopActiveManagedProxyRegistration(registration);
    }
  });

  it("strips invalid IP SNI when undici connects to an HTTPS proxy by IP", () => {
    installUndiciRuntimeDeps();

    createHttp1ProxyAgent({ uri: "https://127.0.0.1:8443" });
    invokeProxyClientFactory(requireProxyAgentOptions());
    invokeClientConnect(requireClientOptions(), "127.0.0.1");

    expect(proxyConnect).toHaveBeenCalledWith(
      expect.not.objectContaining({ servername: "127.0.0.1" }),
      expect.any(Function),
    );
  });

  it("strips invalid bracketed IPv6 SNI when undici connects to an HTTPS proxy by IP", () => {
    installUndiciRuntimeDeps();

    createHttp1ProxyAgent({ uri: "https://[::1]:8443" });
    invokeProxyClientFactory(requireProxyAgentOptions());
    invokeClientConnect(requireClientOptions(), "[::1]");

    expect(proxyConnect).toHaveBeenCalledWith(
      expect.not.objectContaining({ servername: "[::1]" }),
      expect.any(Function),
    );
  });

  it("preserves DNS SNI when undici connects to an HTTPS proxy by hostname", () => {
    installUndiciRuntimeDeps();

    createHttp1ProxyAgent({ uri: "https://proxy.example:8443" });
    invokeProxyClientFactory(requireProxyAgentOptions());
    invokeClientConnect(requireClientOptions(), "proxy.example");

    expect(proxyConnect).toHaveBeenCalledWith(
      expect.objectContaining({ servername: "proxy.example" }),
      expect.any(Function),
    );
  });
});

describe("createHttp1EnvHttpProxyAgent", () => {
  it("installs the IP-safe proxy client factory for env proxy dispatchers", () => {
    installUndiciRuntimeDeps();

    createHttp1EnvHttpProxyAgent({ httpsProxy: "https://127.0.0.1:8443" });
    invokeProxyClientFactory(requireEnvHttpProxyAgentOptions());
    invokeClientConnect(requireClientOptions(), "127.0.0.1");

    expect(proxyConnect).toHaveBeenCalledWith(
      expect.not.objectContaining({ servername: "127.0.0.1" }),
      expect.any(Function),
    );
  });
});
