import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execNodeEvalSync } from "../../test-utils/node-process.js";
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

const poolCtor = vi.fn();
const proxyAgentCtor = vi.fn();
const proxyConnect = vi.fn();
const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";

afterEach(() => {
  Reflect.deleteProperty(globalThis as object, TEST_UNDICI_RUNTIME_DEPS_KEY);
  [poolCtor, proxyAgentCtor, proxyConnect, logDebug].forEach((mock) => mock.mockReset());
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
  constructor(public readonly options?: Record<string, unknown>) {
    super();
  }

  createOriginDispatcher(options: Record<string, unknown>): EventEmitter {
    const factory = this.options?.factory;
    if (typeof factory !== "function") {
      throw new Error("expected origin dispatcher factory");
    }
    return factory(new URL("https://service.test"), options) as EventEmitter;
  }
}

class MockPool extends MockClient {
  constructor(origin: unknown, options: unknown) {
    super(origin, options);
    poolCtor(origin, options);
  }
}

class MockProxyAgent extends MockAgent {
  constructor(options: Record<string, unknown>) {
    super(options);
    proxyAgentCtor(options);
  }
}

function installUndiciRuntimeDeps(): void {
  (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
    Agent: MockAgent,
    Client: MockClient,
    EnvHttpProxyAgent: MockAgent,
    Pool: MockPool,
    ProxyAgent: MockProxyAgent,
    buildConnector: () => proxyConnect,
    fetch: vi.fn(),
  };
}
beforeEach(installUndiciRuntimeDeps);

function requireOptions(mock: ReturnType<typeof vi.fn>, index: number): Record<string, unknown> {
  const options = mock.mock.calls[0]?.[index];
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new Error("expected constructor options");
  }
  return options as Record<string, unknown>;
}

it("loads lazily, retries failed initialization, and reuses the installed API behind overrides", () => {
  const runtimeUrl = new URL("./undici-runtime.ts", import.meta.url).href;
  const packageUrl = new URL("../../../package.json", import.meta.url).href;
  const output = execNodeEvalSync(
    `
      import assert from "node:assert/strict";
      import { EventEmitter } from "node:events";
      import { createRequire, registerHooks } from "node:module";

      let resolutions = 0;
      const hook = registerHooks({
        resolve(specifier, context, nextResolve) {
          if (
            specifier === "undici/index.js" &&
            context.parentURL?.split("?")[0].endsWith("/undici-dispatcher-options.ts")
          ) {
            resolutions++;
            if (resolutions === 1) {
              throw new Error("fixture Undici initialization failure");
            }
          }
          return nextResolve(specifier, context);
        },
      });
      const overrideKey = ${JSON.stringify(TEST_UNDICI_RUNTIME_DEPS_KEY)};
      class OverrideAgent extends EventEmitter {}
      const override = {
        Agent: OverrideAgent,
        EnvHttpProxyAgent: OverrideAgent,
        ProxyAgent: OverrideAgent,
        fetch() {},
      };
      const dispatchers = [];
      try {
        const { createHttp1Agent } = await import(${JSON.stringify(runtimeUrl)});
        assert.equal(resolutions, 0, "import must leave Undici unloaded");
        globalThis[overrideKey] = override;
        assert.ok(createHttp1Agent() instanceof OverrideAgent);
        assert.equal(resolutions, 0, "override must leave Undici unloaded");
        delete globalThis[overrideKey];

        assert.throws(() => createHttp1Agent(), /fixture Undici initialization failure/);
        // Another Gateway consumer can load Undici before this owner retries.
        // This avoids Node's first-loader parent cache masking repeated resolution.
        createRequire(${JSON.stringify(packageUrl)})("undici/index.js");
        dispatchers.push(createHttp1Agent());
        assert.equal(resolutions, 2, "initialization must retry after a failure");

        globalThis[overrideKey] = override;
        assert.ok(createHttp1Agent() instanceof OverrideAgent);
        delete globalThis[overrideKey];
        dispatchers.push(createHttp1Agent());
        assert.equal(dispatchers[1].constructor, dispatchers[0].constructor);
        assert.equal(resolutions, 2, "warm native construction must reuse the installed API");
        console.log("ok");
      } finally {
        delete globalThis[overrideKey];
        hook.deregister();
        await Promise.all(dispatchers.map((dispatcher) => dispatcher.destroy()));
        assert.ok(dispatchers.every((dispatcher) => dispatcher.destroyed));
      }
      `,
    { imports: ["tsx"] },
  );

  expect(output.trim()).toBe("ok");
});
it("handles an internal error from direct agent client before connect", () => {
  const agent = createHttp1Agent() as unknown as MockAgent;
  const client = agent.createOriginDispatcher({ connections: 1 });
  const error = new Error("stream handler aborted");

  expect(() => client.emit("error", error)).not.toThrow();
  expect(logDebug).toHaveBeenCalledWith(expect.stringContaining(error.message));
});
it("adds active managed proxy CA trust to explicit ProxyAgent options", () => {
  const registration = registerActiveManagedProxyUrl(new URL("https://proxy.test:8443"), {
    proxyTls: { ca: "explicit-proxy-agent-ca" },
  });

  try {
    createHttp1ProxyAgent({ uri: "https://proxy.test:8443" });

    expect(requireOptions(proxyAgentCtor, 0)).toMatchObject({
      uri: "https://proxy.test:8443",
      allowH2: false,
      proxyTls: { ca: "explicit-proxy-agent-ca" },
    });
  } finally {
    stopActiveManagedProxyRegistration(registration);
  }
});
it.each([
  { mode: "fixed", servername: "proxy.example", preserve: true },
  { mode: "environment", servername: "127.0.0.1", preserve: false },
])("handles $servername through the $mode proxy", ({ mode, servername, preserve }) => {
  const uri = `https://${servername}:8443`;
  if (mode === "environment") {
    createHttp1EnvHttpProxyAgent({ httpsProxy: uri });
  } else {
    createHttp1ProxyAgent({ uri });
  }
  const { clientFactory } = requireOptions(proxyAgentCtor, 0);
  if (typeof clientFactory !== "function") {
    throw new Error("expected ProxyAgent clientFactory");
  }
  clientFactory(new URL("https://127.0.0.1:8443"), { connect: proxyConnect });
  const { connect } = requireOptions(poolCtor, 1);
  if (typeof connect !== "function") {
    throw new Error("expected wrapped Client connect");
  }
  connect({ host: "127.0.0.1:8443", servername }, vi.fn());

  expect(proxyConnect).toHaveBeenCalledWith(
    preserve
      ? expect.objectContaining({ servername })
      : expect.not.objectContaining({ servername }),
    expect.any(Function),
  );
});
