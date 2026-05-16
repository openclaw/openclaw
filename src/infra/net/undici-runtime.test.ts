import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetActiveManagedProxyStateForTests,
  registerActiveManagedProxyUrl,
  stopActiveManagedProxyRegistration,
} from "./proxy/active-proxy-state.js";
import { createHttp1ProxyAgent, TEST_UNDICI_RUNTIME_DEPS_KEY } from "./undici-runtime.js";

const proxyAgentCtor = vi.fn();

class MockAgent {
  readonly __testStub = true;
}

class MockEnvHttpProxyAgent {
  readonly __testStub = true;
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
    EnvHttpProxyAgent: MockEnvHttpProxyAgent,
    ProxyAgent: MockProxyAgent,
    fetch: vi.fn(),
  };
}

function requireProxyAgentOptions(): Record<string, unknown> {
  const call = proxyAgentCtor.mock.calls[0];
  if (!call) {
    throw new Error("expected ProxyAgent constructor call");
  }
  const options = call[0];
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new Error("expected ProxyAgent options object");
  }
  return options as Record<string, unknown>;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis as object, TEST_UNDICI_RUNTIME_DEPS_KEY);
  proxyAgentCtor.mockReset();
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
});
