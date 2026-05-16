import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetActiveManagedProxyStateForTests,
  registerActiveManagedProxyUrl,
  stopActiveManagedProxyRegistration,
} from "./proxy/active-proxy-state.js";
import {
  createHttp1EnvHttpProxyAgent,
  createHttp1ProxyAgent,
  TEST_UNDICI_RUNTIME_DEPS_KEY,
} from "./undici-runtime.js";

const clientCtor = vi.fn();
const envHttpProxyAgentCtor = vi.fn();
const proxyAgentCtor = vi.fn();
const proxyConnect = vi.fn();

class MockAgent {
  readonly __testStub = true;
}

class MockClient {
  readonly __testStub = true;

  constructor(
    public readonly origin: unknown,
    public readonly options: unknown,
  ) {
    clientCtor(origin, options);
  }
}

class MockEnvHttpProxyAgent {
  readonly __testStub = true;

  constructor(public readonly options: unknown) {
    envHttpProxyAgentCtor(options);
  }
}

class MockProxyAgent {
  readonly __testStub = true;

  constructor(public readonly options: unknown) {
    proxyAgentCtor(options);
  }
}

function installUndiciRuntimeDeps(): void {
  (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
    Agent: MockAgent,
    Client: MockClient,
    EnvHttpProxyAgent: MockEnvHttpProxyAgent,
    ProxyAgent: MockProxyAgent,
    fetch: vi.fn(),
  };
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
  const call = clientCtor.mock.calls[0];
  if (!call) {
    throw new Error("expected Client constructor call");
  }
  return expectOptionsRecord(call[1], "expected Client options object");
}

function invokeProxyClientFactory(options: Record<string, unknown>): void {
  const clientFactory = options.clientFactory;
  if (typeof clientFactory !== "function") {
    throw new Error("expected ProxyAgent clientFactory");
  }
  clientFactory(new URL("https://127.0.0.1:8443"), { connect: proxyConnect });
}

function invokeClientConnect(options: Record<string, unknown>, servername: string): void {
  const connect = options.connect;
  if (typeof connect !== "function") {
    throw new Error("expected wrapped Client connect");
  }
  connect({ host: "127.0.0.1:8443", servername }, vi.fn());
}

afterEach(() => {
  Reflect.deleteProperty(globalThis as object, TEST_UNDICI_RUNTIME_DEPS_KEY);
  clientCtor.mockReset();
  envHttpProxyAgentCtor.mockReset();
  proxyAgentCtor.mockReset();
  proxyConnect.mockReset();
  _resetActiveManagedProxyStateForTests();
});

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
