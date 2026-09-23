import { EventEmitter } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const DESTINATION_AGENT = Symbol("destination agent");

afterEach(() => {
  Reflect.deleteProperty(globalThis as object, TEST_UNDICI_RUNTIME_DEPS_KEY);
  MockProxyAgent.latest = undefined;
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
  constructor(public readonly options?: Record<string, unknown>) {
    super();
  }

  createOriginDispatcher(options: Record<string, unknown>): EventEmitter {
    const factory = this.options?.factory;
    return typeof factory === "function"
      ? (factory(new URL("https://service.test"), options) as EventEmitter)
      : options.connections === 1
        ? new MockClient(new URL("https://service.test"), options)
        : new MockPool(new URL("https://service.test"), options);
  }
}

class MockPool extends EventEmitter {
  constructor(
    public readonly origin: unknown,
    public readonly options: unknown,
  ) {
    super();
    poolCtor(origin, options);
  }
}

class MockEnvHttpProxyAgent extends EventEmitter {
  readonly [DESTINATION_AGENT]: MockAgent;

  constructor(public readonly options: unknown) {
    super();
    this[DESTINATION_AGENT] = new MockAgent(
      expectOptionsRecord(options, "expected EnvHttpProxyAgent options"),
    );
  }
}

class MockProxyAgent extends EventEmitter {
  static latest: MockProxyAgent | undefined;
  readonly [DESTINATION_AGENT]: MockAgent;

  constructor(public readonly options: unknown) {
    super();
    this[DESTINATION_AGENT] = new MockAgent(
      expectOptionsRecord(options, "expected ProxyAgent options"),
    );
    proxyAgentCtor(options);
    MockProxyAgent.latest = this;
  }
}

function installUndiciRuntimeDeps(): void {
  (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
    Agent: MockAgent,
    Client: MockClient,
    EnvHttpProxyAgent: MockEnvHttpProxyAgent,
    Pool: MockPool,
    ProxyAgent: MockProxyAgent,
    buildConnector: () => proxyConnect,
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

describe("installed dispatcher lifecycle", () => {
  it("loads lazily, retries failed initialization, and reuses the installed API behind overrides", () => {
    const runtimeUrl = pathToFileURL(path.resolve("src/infra/net/undici-runtime.ts")).href;
    const packageUrl = pathToFileURL(path.resolve("package.json")).href;
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
      }
      `,
      { imports: ["tsx"] },
    );

    expect(output.trim()).toBe("ok");
  });

  it.each([
    ["close", "closed"],
    ["destroy", "destroyed"],
  ] as const)("supports %s without a runtime override", async (method, state) => {
    const dispatcher = createHttp1Agent();

    await dispatcher[method]();

    expect(dispatcher[state]).toBe(true);
  });
});

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
        const agent = createHttp1ProxyAgent({
          uri: "http://proxy.test:8080",
        }) as unknown as MockProxyAgent;
        return agent[DESTINATION_AGENT].createOriginDispatcher({ connections: 1 });
      },
    },
    {
      name: "environment proxy client",
      createClient: () => {
        createHttp1EnvHttpProxyAgent({
          httpsProxy: "http://proxy.test:8080",
        });
        const agent = MockProxyAgent.latest;
        if (!agent) {
          throw new Error("expected environment proxy transport");
        }
        return agent[DESTINATION_AGENT].createOriginDispatcher({ connections: 1 });
      },
    },
  ])("handles an internal error from $name before connect", ({ createClient }) => {
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
  it.each(["own", "inherited", "non-enumerable"])(
    "uses the caller's %s proxy client factory",
    (placement) => {
      installUndiciRuntimeDeps();
      const clientFactory = vi.fn(() => createHttp1Agent());
      const options = { uri: "http://proxy.test:8080" };
      if (placement === "inherited") {
        Object.setPrototypeOf(options, { clientFactory });
      } else {
        Object.defineProperty(options, "clientFactory", {
          value: clientFactory,
          enumerable: placement === "own",
        });
      }

      createHttp1ProxyAgent(options);
      invokeProxyClientFactory(requireProxyAgentOptions());

      expect(clientFactory).toHaveBeenCalledExactlyOnceWith(new URL("https://127.0.0.1:8443"), {
        connect: proxyConnect,
      });
    },
  );

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

describe("proxy SNI policy", () => {
  it.each([
    { mode: "fixed", servername: "127.0.0.1", preserve: false },
    { mode: "fixed", servername: "[::1]", preserve: false },
    { mode: "fixed", servername: "proxy.example", preserve: true },
    { mode: "environment", servername: "127.0.0.1", preserve: false },
  ])("handles $servername through the $mode proxy", ({ mode, servername, preserve }) => {
    installUndiciRuntimeDeps();

    const uri = `https://${servername}:8443`;
    if (mode === "environment") {
      createHttp1EnvHttpProxyAgent({ httpsProxy: uri });
    } else {
      createHttp1ProxyAgent({ uri });
    }
    invokeProxyClientFactory(requireProxyAgentOptions());
    invokeClientConnect(requireClientOptions(), servername);

    expect(proxyConnect).toHaveBeenCalledWith(
      preserve
        ? expect.objectContaining({ servername })
        : expect.not.objectContaining({ servername }),
      expect.any(Function),
    );
  });
});
