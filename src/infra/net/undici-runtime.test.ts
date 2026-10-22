import { EventEmitter } from "node:events";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execNodeEvalSync } from "../../test-utils/node-process.js";
import { getProxyUrlFromFetch, makeProxyFetch, resolveProxyFetchFromEnv } from "./proxy-fetch.js";
import { fetchWithRuntimeDispatcher } from "./runtime-fetch.js";
import * as runtime from "./undici-runtime.js";
import {
  createHttp1Agent,
  createHttp1EnvHttpProxyAgent,
  createHttp1ProxyAgent,
} from "./undici-runtime.js";

const logDebug = vi.hoisted(() => vi.fn());

vi.mock("../../logger.js", () => ({ logDebug, logWarn: vi.fn() }));

const poolCtor = vi.fn();
const proxyAgentCtor = vi.fn();
const proxyConnect = vi.fn();
const envAgentCtor = vi.fn();
const undiciFetch = vi.fn<typeof fetch>();
const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";
class MockUndiciFormData {
  readonly entriesList: [string, unknown, string | undefined][] = [];
  append(key: string, value: unknown, filename?: string) {
    this.entriesList.push([key, value, filename]);
  }
}

afterEach(() => {
  Reflect.deleteProperty(globalThis as object, TEST_UNDICI_RUNTIME_DEPS_KEY);
  [poolCtor, proxyAgentCtor, proxyConnect, logDebug, envAgentCtor, undiciFetch].forEach((mock) =>
    mock.mockReset(),
  );
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

class MockClient extends EventEmitter {}

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

beforeEach(() => {
  undiciFetch.mockResolvedValue(new Response());
  for (const key of "HTTPS_PROXY HTTP_PROXY ALL_PROXY https_proxy http_proxy all_proxy".split(
    " ",
  )) {
    vi.stubEnv(key, undefined);
  }
  poolCtor.mockImplementation(function (_origin: unknown, _options: unknown) {
    return new MockClient();
  });
  proxyAgentCtor.mockImplementation(function (options: Record<string, unknown>) {
    return new MockAgent(options);
  });
  envAgentCtor.mockImplementation(function (options: Record<string, unknown>) {
    return new MockAgent(options);
  });
  (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
    Agent: MockAgent,
    Client: MockClient,
    EnvHttpProxyAgent: envAgentCtor,
    Pool: poolCtor,
    ProxyAgent: proxyAgentCtor,
    buildConnector: () => proxyConnect,
    FormData: MockUndiciFormData,
    fetch: undiciFetch,
  };
});

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

const requireFetchCall = () => expectDefined(undiciFetch.mock.calls[0], "runtime fetch call");

it("drops symbol header metadata before runtime fetch without mutating caller headers", async () => {
  const headers = { "Content-Type": "application/json" };
  Object.defineProperty(headers, Symbol("sensitiveHeaders"), {
    value: new Set(["content-type"]),
    enumerable: false,
  });
  const response = await fetchWithRuntimeDispatcher("https://example.com", {
    method: "POST",
    headers,
    body: "{}",
  });
  expect(response.status).toBe(200);
  expect(undiciFetch).toHaveBeenCalledOnce();
  const sentHeaders = requireFetchCall()[1]?.headers;
  expect(new Headers(sentHeaders).get("content-type")).toBe("application/json");
  expect(sentHeaders).not.toBe(headers);
  expect(Object.getOwnPropertySymbols(sentHeaders as object)).toStrictEqual([]);
  expect(Object.getOwnPropertySymbols(headers)).toHaveLength(1);
});

it("converts global FormData bodies before dispatching through undici", async () => {
  const form = new globalThis.FormData();
  form.append("model", "whisper-1");
  form.append("file", new Blob([new Uint8Array(4)], { type: "audio/ogg" }), "voice.ogg");
  await makeProxyFetch("http://proxy.test:8080")(
    "https://api.example.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { "content-length": "999", "content-type": "multipart/form-data; boundary=stale" },
      body: form,
    },
  );
  const [, init] = requireFetchCall();
  expect(init?.body).toBeInstanceOf(MockUndiciFormData);
  expect(init).toMatchObject({
    body: {
      entriesList: [
        ["model", "whisper-1", undefined],
        ["file", expect.any(Blob), "voice.ogg"],
      ],
    },
  });
  const headers = new Headers(init?.headers);
  expect([headers.has("content-length"), headers.has("content-type")]).toEqual([false, false]);
});

it("returns undefined for plain fetch functions or blank metadata", () => {
  expect(getProxyUrlFromFetch(vi.fn<typeof fetch>())).toBeUndefined();
  expect(getProxyUrlFromFetch(makeProxyFetch("   "))).toBeUndefined();
});

it("returns proxy fetch using EnvHttpProxyAgent when HTTPS_PROXY is set", async () => {
  const create = vi.spyOn(runtime, "createHttp1EnvHttpProxyAgent");
  const fetchFn = expectDefined(
    resolveProxyFetchFromEnv({
      HTTP_PROXY: "",
      HTTPS_PROXY: "http://proxy.test:8080",
    }),
    "proxy fetch",
  );
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ httpsProxy: "http://proxy.test:8080" }),
    undefined,
    { HTTP_PROXY: "", HTTPS_PROXY: "http://proxy.test:8080" },
  );
  await fetchFn("https://api.example.com");
  expect(undiciFetch).toHaveBeenCalledOnce();
  expect(requireFetchCall()).toEqual([
    "https://api.example.com",
    expect.objectContaining({ dispatcher: create.mock.results[0]?.value }),
  ]);
});

it("returns undefined when EnvHttpProxyAgent constructor throws", () => {
  envAgentCtor.mockImplementationOnce(() => {
    throw new Error("Invalid URL");
  });
  expect(
    resolveProxyFetchFromEnv({
      HTTP_PROXY: "",
      https_proxy: "",
      http_proxy: "",
      HTTPS_PROXY: "http://proxy.test:8080",
    }),
  ).toBeUndefined();
});
