import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { consumeResponseBytes } from "@openclaw/normalization-core";
import {
  buildConnector,
  fetch as undiciFetch,
  getGlobalDispatcher,
  Response as UndiciResponse,
  setGlobalDispatcher,
} from "undici";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  PROXY_FIXTURE_HOST as TARGET_HOST,
  PROXY_FIXTURE_PAYLOAD as PAYLOAD,
  withProxyFixture,
} from "../../test-fixtures/proxy-fixture.js";
import { readResponseWithLimit } from "../http-body.js";
import { fetchWithSsrFGuard } from "./fetch-guard.js";
import { resolveProxyFetchFromEnv } from "./proxy-fetch.js";
import {
  registerActiveManagedProxyUrl,
  stopActiveManagedProxyRegistration,
} from "./proxy/active-proxy-state.js";
import * as familyPolicy from "./undici-family-policy.js";
import {
  ensureGlobalUndiciDispatcherStreamTimeouts,
  forceResetGlobalDispatcher,
  resetGlobalUndiciStreamTimeoutsForTests,
} from "./undici-global-dispatcher.js";
import * as undiciRuntime from "./undici-runtime.js";
import { createHttp1EnvHttpProxyAgent, createHttp1ProxyAgent } from "./undici-runtime.js";

// Undici exposes its deadline clock for tests; network I/O stays real.
const undiciTimers: { tick: (delay: number) => void } = createRequire(import.meta.url)(
  "undici/lib/util/timers.js",
);

const TARGET_URL = `https://${TARGET_HOST}/media`;
const HTTP_URL = `http://${TARGET_HOST}/media`;
const PAYLOAD_BYTES = Buffer.byteLength(PAYLOAD);
const mediaRequest = { origin: `http://${TARGET_HOST}`, path: "/media", method: "GET" as const };
type ProxyFixture = Parameters<Parameters<typeof withProxyFixture>[0]>[0];
type EnvOptions = Parameters<typeof createHttp1EnvHttpProxyAgent>[0];

async function readProxyPayload(response: Response | UndiciResponse): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Proxy fixture response has no body");
  }
  const chunks: Uint8Array[] = [];
  try {
    const result = await consumeResponseBytes({
      maxBytes: PAYLOAD_BYTES,
      read: () => reader.read(),
      onChunk: (chunk) => chunks.push(chunk),
      onLimit: () => void reader.cancel().catch(() => undefined),
    });
    expect(result.truncated).toBe(false);
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}

function envProxy(
  { socksProxy, certificate }: ProxyFixture,
  options: EnvOptions = {},
  timeout?: number,
  env?: NodeJS.ProcessEnv,
) {
  return createHttp1EnvHttpProxyAgent(
    { httpProxy: socksProxy, requestTls: { ca: certificate }, noProxy: "", ...options },
    timeout,
    env,
  );
}

async function fetchPayload(dispatcher: ReturnType<typeof createHttp1ProxyAgent>) {
  await withDispatcher(dispatcher, () => expectPayload(dispatcher, TARGET_URL, 5_000));
}

async function expectPayload(
  dispatcher: ReturnType<typeof createHttp1ProxyAgent>,
  url = TARGET_URL,
  timeout?: number,
) {
  const response = await undiciFetch(url, {
    dispatcher,
    ...(timeout === undefined ? {} : { signal: AbortSignal.timeout(timeout) }),
  });
  expect(await readProxyPayload(response)).toBe(PAYLOAD);
}

async function withDispatcher<T>(
  dispatcher: ReturnType<typeof createHttp1ProxyAgent>,
  run: () => Promise<T>,
) {
  try {
    return await run();
  } finally {
    await dispatcher.destroy();
  }
}

it.each([
  {
    input: "conflicting credentials",
    options: { auth: "fixture-auth", token: "fixture-token" },
    error: "opts.auth cannot be used in combination with opts.token",
  },
  {
    input: "null clientFactory",
    options: { clientFactory: null },
    error: "Proxy opts.clientFactory must be a function.",
  },
])("preserves SOCKS constructor refusal for $input", async ({ options, error }) => {
  let dispatcher: ReturnType<typeof createHttp1ProxyAgent> | undefined;
  try {
    expect(() => {
      // JavaScript SDK callers can supply malformed constructor options.
      dispatcher = Reflect.apply(createHttp1ProxyAgent, undefined, [
        { uri: "socks5://127.0.0.1:1080", ...options },
      ]);
    }).toThrow(error);
  } finally {
    await dispatcher?.destroy();
  }
});

it("authenticates decoded SOCKS URL credentials", async () => {
  const credentials = { username: "fixture@user:space %", password: "fixture:p@ss/%" };
  await withProxyFixture(async ({ socksProxy, certificate, connections, originRoutes }) => {
    const url = new URL(socksProxy);
    url.username = encodeURIComponent(credentials.username);
    const create = () =>
      createHttp1EnvHttpProxyAgent({
        requestTls: { ca: certificate },
        httpsProxy: url.href,
        noProxy: "",
      });
    url.password = encodeURIComponent(`${credentials.password}-wrong`);
    const rejected = create();
    await withDispatcher(rejected, async () => {
      await expect(
        undiciFetch(TARGET_URL, { dispatcher: rejected, signal: AbortSignal.timeout(5_000) }),
      ).rejects.toMatchObject({ cause: { code: "UND_ERR_SOCKS5_AUTH_FAILED" } });
      expect({ connections, originRoutes }).toEqual({ connections: [], originRoutes: [] });
    });
    url.password = encodeURIComponent(credentials.password);
    await fetchPayload(create());
    expect({ connections, originRoutes }).toEqual({
      connections: [`socks:${TARGET_HOST}`],
      originRoutes: ["proxy"],
    });
  }, credentials);
});

it("preserves TCP policy on the actual SOCKS proxy connection", async () => {
  const family = vi
    .spyOn(familyPolicy, "resolveUndiciAutoSelectFamilyConnectOptions")
    .mockReturnValue({ autoSelectFamily: false, autoSelectFamilyAttemptTimeout: 321 });
  const connect = vi.spyOn(net, "connect");
  const keepAlive = vi.spyOn(net.Socket.prototype, "setKeepAlive");
  try {
    await withProxyFixture(async (fixture) => {
      await fetchPayload(
        envProxy(fixture, {
          connect: { family: 4, keepAlive: true, keepAliveInitialDelay: 30_000 },
          httpsProxy: fixture.socksProxy,
        }),
      );
      const proxyPort = Number(new URL(fixture.socksProxy).port);
      const socketCalls: ReadonlyArray<readonly unknown[]> = connect.mock.calls;
      const proxyIndex = socketCalls.findIndex(
        ([value]) =>
          value !== null &&
          typeof value === "object" &&
          "port" in value &&
          Number(value.port) === proxyPort,
      );
      const proxySocket = connect.mock.results[proxyIndex]?.value;
      expect({
        options: socketCalls[proxyIndex]?.[0],
        keepAliveCalls: keepAlive.mock.calls.filter(
          (_, index) => keepAlive.mock.contexts[index] === proxySocket,
        ),
      }).toMatchObject({
        options: { family: 4, autoSelectFamily: false, autoSelectFamilyAttemptTimeout: 321 },
        keepAliveCalls: [[true, 30_000]],
      });
    });
  } finally {
    connect.mockRestore();
    keepAlive.mockRestore();
    family.mockRestore();
  }
});

// The dispatchers share Undici's clock, so each handshake must settle before the next row.
it.each([
  { name: "target despite wrapper budget", stall: "target", target: 100, budget: 5_000 },
  { name: "request TLS override", stall: "target", target: 0, request: 100, budget: 5_000 },
  { name: "proxy TLS override", stall: "proxy", target: 0, proxy: 100 },
  {
    name: "wrapper over null proxy default",
    stall: "proxy",
    target: 0,
    proxy: null,
    budget: 100,
  },
  {
    name: "environment direct-only connector timeout",
    mode: "environment",
    stall: "proxy",
    target: undefined,
    generic: 0,
    omitProxyTimeout: true,
    protocol: "socks5",
    defaultProxyTimeout: true,
  },
])(
  "preserves the independent $name deadline",
  async ({
    mode = "fixed",
    stall,
    target,
    proxy = 0,
    request,
    budget,
    protocol,
    defaultProxyTimeout,
    generic,
    omitProxyTimeout,
  }) => {
    const server = stall === "proxy" ? net.createServer() : http.createServer();
    const sockets = new Set<net.Socket>();
    let sawTlsHandshake = false;
    const handshake = createDeferred();
    const observeTls = (chunk: Buffer) => {
      sawTlsHandshake = chunk[0] === 22;
      handshake.resolve();
    };
    server.on("connection", (socket: net.Socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
      if (stall === "proxy") {
        socket.once("data", observeTls);
      }
    });
    if (server instanceof http.Server) {
      server.on("connect", (_request, socket) => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        socket.once("data", observeTls);
      });
    }
    let dispatcher: ReturnType<typeof createHttp1ProxyAgent> | undefined;
    try {
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected a listening loopback proxy");
      }
      const uri = `${protocol ?? (stall === "proxy" ? "https" : "http")}://127.0.0.1:${address.port}`;
      const options = {
        connectTimeout: target,
        proxyTls: omitProxyTimeout ? {} : { timeout: proxy },
        ...(generic === undefined ? {} : { connect: { timeout: generic } }),
        ...(request === undefined ? {} : { requestTls: { timeout: request } }),
      };
      if (mode === "environment") {
        dispatcher = createHttp1EnvHttpProxyAgent(
          // @ts-expect-error Undici's Node TLS intersection rejects its runtime-valid null timeout.
          { ...options, httpProxy: uri, httpsProxy: uri, noProxy: "" },
          budget,
        );
      } else {
        // @ts-expect-error Undici's Node TLS intersection rejects its runtime-valid null timeout.
        dispatcher = createHttp1ProxyAgent({ ...options, uri }, budget);
      }
      const outcome = undiciFetch(TARGET_URL, {
        dispatcher,
        // Undici's explicit null/undefined timeout contract uses its 10-second default.
        signal: AbortSignal.timeout(defaultProxyTimeout ? 12_000 : 2_000),
      }).catch((error: unknown) => error);
      await Promise.race([
        handshake.promise,
        outcome.then((result) => {
          throw new Error("Proxy request settled before its TLS handshake", { cause: result });
        }),
      ]);
      const deadlineMs = defaultProxyTimeout ? 10_000 : 100;
      // First initialize pending FastTimers, then expire the unchanged connector deadline.
      undiciTimers.tick(0);
      undiciTimers.tick(deadlineMs);
      expect(sawTlsHandshake).toBe(true);
      expect(await outcome).toMatchObject({
        cause: {
          code: "UND_ERR_CONNECT_TIMEOUT",
          message: expect.stringContaining(`timeout: ${deadlineMs}ms`),
        },
      });
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await dispatcher?.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  },
  15_000,
);

it.each(["flat array", "inherited object"])(
  "rejects per-request proxy credentials from %s before any SOCKS dispatch",
  async (form) => {
    await withProxyFixture(async ({ socksProxy, connections, originRoutes }) => {
      const dispatcher = form.endsWith("object")
        ? createHttp1ProxyAgent(socksProxy)
        : createHttp1EnvHttpProxyAgent({ httpProxy: socksProxy, noProxy: "" });
      const auth = { "pRoXy-AuThOrIzAtIoN": "Basic fixture-proxy-only" };
      const inherited = {};
      Object.setPrototypeOf(inherited, auth);
      await withDispatcher(dispatcher, async () => {
        const request = dispatcher.request({
          ...mediaRequest,
          headers: form === "flat array" ? Object.entries(auth).flat() : inherited,
        });
        await expect(request).rejects.toMatchObject({ code: "UND_ERR_INVALID_ARG" });
        expect({ connections, originRoutes }).toEqual({ connections: [], originRoutes: [] });
        const response = await dispatcher.request({
          ...mediaRequest,
          headers: { Authorization: "Bearer fixture-origin-only" },
        });
        expect(await readProxyPayload(new UndiciResponse(response.body))).toBe(PAYLOAD);
        expect(connections).toEqual([`socks:${TARGET_HOST}`]);
      });
    });
  },
);

it("keeps supplied-env managed TLS on the HTTPS proxy hop", () =>
  withProxyFixture(async (fixture) => {
    const { httpsProxy, connections, certificate } = fixture;
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-socks-ca-"));
    const caFile = path.join(dir, "ca.pem");
    await writeFile(caFile, certificate);
    const dispatcher = envProxy(fixture, { httpsProxy }, undefined, {
      HTTPS_PROXY: httpsProxy,
      OPENCLAW_PROXY_ACTIVE: "1",
      OPENCLAW_PROXY_CA_FILE: caFile,
    });
    try {
      for (const url of [HTTP_URL, TARGET_URL]) {
        await expectPayload(dispatcher, url);
      }
      expect(connections).toEqual([`socks:${TARGET_HOST}`, `https:${TARGET_HOST}`]);
    } finally {
      await dispatcher.destroy();
      await rm(dir, { recursive: true, force: true });
    }
  }));

it("routes mixed TLS proxies with HTTP/1 ALPN", () =>
  withProxyFixture(async (fixture) => {
    const { tlsSocksProxy, httpsProxy, connections, certificate } = fixture;
    const dispatcher = envProxy(
      fixture,
      {
        httpProxy: tlsSocksProxy,
        httpsProxy,
        proxyTls: { ca: certificate, servername: TARGET_HOST },
      },
      5_000,
    );
    await withDispatcher(dispatcher, async () => {
      await expectPayload(dispatcher, HTTP_URL);
      const protocol = fixture.waitForProxyProtocol();
      await expectPayload(dispatcher);
      expect(await protocol).toBe("http/1.1");
      expect(connections).toEqual([`socks:${TARGET_HOST}`, `https:${TARGET_HOST}`]);
    });
    await fixture.waitForSocketsClosed();
  }));

it.each([
  { proxy: "HTTPS", kind: "trust" },
  { proxy: "SOCKS-over-TLS", kind: "connector" },
])("keeps direct-origin TLS $kind out of $proxy proxy policy", async ({ proxy, kind }) => {
  await withProxyFixture(async ({ httpsProxy, tlsSocksProxy, certificate, connections }) => {
    const options = {
      httpsProxy: proxy === "HTTPS" ? httpsProxy : tlsSocksProxy,
      noProxy: "",
      connect:
        kind === "connector" ? buildConnector({ rejectUnauthorized: false }) : { ca: certificate },
      requestTls: { ca: certificate },
      ...(proxy === "HTTPS" ? {} : { proxyTls: { servername: TARGET_HOST } }),
    };
    const untrusted = createHttp1EnvHttpProxyAgent(options, 5_000);
    await withDispatcher(untrusted, async () => {
      await expect(undiciFetch(TARGET_URL, { dispatcher: untrusted })).rejects.toMatchObject({
        cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
      });
      expect(connections).toEqual([]);
    });
    await fetchPayload(
      createHttp1EnvHttpProxyAgent(
        { ...options, proxyTls: { ...options.proxyTls, ca: certificate } },
        5_000,
      ),
    );
    expect(connections).toEqual([`${proxy === "HTTPS" ? "https" : "socks"}:${TARGET_HOST}`]);
  });
});

it("keeps managed trust isolated between two native HTTPS proxy hops", () =>
  withProxyFixture(async (fixture) => {
    const { httpsProxy, otherHttpsProxy, certificate, connections } = fixture;
    const registration = registerActiveManagedProxyUrl(new URL(httpsProxy), {
      proxyTls: { ca: certificate },
    });
    const dispatcher = envProxy(fixture, { httpProxy: otherHttpsProxy, httpsProxy }, 5_000);
    try {
      await expect(undiciFetch(HTTP_URL, { dispatcher })).rejects.toMatchObject({
        cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
      });
      expect(connections).toEqual([]);
      await expectPayload(dispatcher);
      expect(connections).toEqual([`https:${TARGET_HOST}`]);
    } finally {
      await dispatcher.destroy();
      stopActiveManagedProxyRegistration(registration);
    }
  }));

it.each(["127.0.0.0/8", "127.0.*"])(
  "routes confirmed NO_PROXY=%s directly despite another native proxy",
  async (noProxy) => {
    await withProxyFixture(
      async ({ httpProxy, socksProxy, httpsOrigin, certificate, connections, originRoutes }) => {
        const dispatcher = createHttp1EnvHttpProxyAgent({
          httpProxy,
          httpsProxy: socksProxy,
          noProxy,
          connect: { ca: certificate },
        });
        await withDispatcher(dispatcher, async () => {
          await expectPayload(dispatcher, `${httpsOrigin}/media`, 5_000);
          expect(connections).toEqual([]);
          expect(originRoutes).toEqual(["direct"]);
        });
      },
    );
  },
);

it("joins an in-flight graceful close while the SOCKS response drains", () =>
  withProxyFixture(async ({ socksProxy, waitForSocketsClosed }) => {
    const dispatcher = createHttp1EnvHttpProxyAgent({ httpProxy: socksProxy, noProxy: "" });
    await withDispatcher(dispatcher, async () => {
      const response = await undiciFetch(`http://${TARGET_HOST}/stall`, { dispatcher });
      const first = dispatcher.close();
      // Empty native children finish through microtasks; the SOCKS response still owns work.
      await setImmediate();
      const destroyedWhileDraining = Reflect.get(dispatcher, "destroyed");
      const second = dispatcher.close().then(
        () => "closed",
        (error: unknown) => error,
      );
      await response.body?.cancel();
      await first;
      expect.soft(destroyedWhileDraining).toBe(false);
      expect(await second).toBe("closed");
      expect(Reflect.get(dispatcher, "destroyed")).toBe(true);
      await waitForSocketsClosed();
    });
  }));

it("preserves maxOrigins admission with an active SOCKS response", () =>
  withProxyFixture(async (fixture) => {
    const dispatcher = envProxy(fixture, { maxOrigins: 1 });
    let response: Awaited<ReturnType<typeof undiciFetch>> | undefined;
    try {
      response = await undiciFetch(`http://${TARGET_HOST}/stall`, {
        dispatcher,
        signal: AbortSignal.timeout(5_000),
      });
      await expect(
        undiciFetch(TARGET_URL, { dispatcher, signal: AbortSignal.timeout(5_000) }).then((second) =>
          readProxyPayload(second),
        ),
      ).rejects.toMatchObject({ cause: { code: "UND_ERR_MAX_ORIGINS_REACHED" } });
      expect(fixture.originRoutes).toEqual(["proxy"]);
    } finally {
      await response?.body?.cancel();
      await dispatcher.destroy();
    }
  }));

it("does not replace an explicit SOCKS global dispatcher with a default Agent", async () => {
  const previous = getGlobalDispatcher();
  const dispatcher = createHttp1ProxyAgent("socks5://127.0.0.1:1080");
  try {
    setGlobalDispatcher(dispatcher);
    ensureGlobalUndiciDispatcherStreamTimeouts();
    expect(getGlobalDispatcher()).toBe(dispatcher);
  } finally {
    const current = getGlobalDispatcher();
    setGlobalDispatcher(previous);
    resetGlobalUndiciStreamTimeoutsForTests();
    await dispatcher.destroy();
    if (current !== dispatcher && current !== previous) {
      await current.destroy();
    }
  }
});

it.each(["proxy-fetch", "global"])("keeps managed TLS hop-local through %s", async (entry) => {
  await withProxyFixture(async ({ socksProxy, httpsProxy, certificate, connections }) => {
    const registration = registerActiveManagedProxyUrl(new URL(httpsProxy), {
      proxyTls: { ca: certificate },
    });
    const previous = getGlobalDispatcher();
    const created: ReturnType<typeof createHttp1EnvHttpProxyAgent>[] = [];
    const create = undiciRuntime.createHttp1EnvHttpProxyAgent;
    const capture = vi
      .spyOn(undiciRuntime, "createHttp1EnvHttpProxyAgent")
      .mockImplementation((...args) => {
        const dispatcher = create(...args);
        created.push(dispatcher);
        return dispatcher;
      });
    const env = { http_proxy: socksProxy, https_proxy: httpsProxy, no_proxy: "" };
    try {
      for (const [key, value] of Object.entries(env)) {
        vi.stubEnv(key, value);
      }
      const fetch = entry === "proxy-fetch" ? resolveProxyFetchFromEnv(env) : undiciFetch;
      if (entry === "global") {
        forceResetGlobalDispatcher();
      }
      if (!fetch) {
        throw new Error("expected configured proxy fetch");
      }
      const response = await fetch(HTTP_URL);
      expect(await readProxyPayload(response)).toBe(PAYLOAD);
      expect(connections).toEqual([`socks:${TARGET_HOST}`]);
    } finally {
      setGlobalDispatcher(previous);
      resetGlobalUndiciStreamTimeoutsForTests();
      await Promise.all(created.map((dispatcher) => dispatcher.destroy()));
      capture.mockRestore();
      vi.unstubAllEnvs();
      stopActiveManagedProxyRegistration(registration);
    }
  });
});

it.each([
  { method: "close", noProxy: undefined, routes: ["proxy", "direct", "proxy"] },
  { method: "destroy", noProxy: "", routes: ["proxy", "proxy", "proxy"] },
] as const)(
  "honors noProxy=$noProxy and $method callback completion on the same env dispatcher",
  async ({ method, noProxy, routes }) => {
    await withProxyFixture(
      async ({ socksProxy, httpOrigin, originRoutes, waitForSocketsClosed }) => {
        const direct = new URL(httpOrigin);
        const connect = buildConnector({});
        vi.stubEnv("no_proxy", "");
        vi.stubEnv("NO_PROXY", "*");
        const dispatcher = createHttp1EnvHttpProxyAgent({
          httpProxy: socksProxy,
          noProxy,
          connect: (params, callback) =>
            connect(
              params.hostname === TARGET_HOST
                ? { ...params, hostname: direct.hostname, port: direct.port }
                : params,
              callback,
            ),
        });
        try {
          expect(dispatcher).toMatchObject({ closed: false, destroyed: false });
          expect(() =>
            Reflect.apply(
              dispatcher[method],
              dispatcher,
              method === "close" ? ["invalid"] : [null, "invalid"],
            ),
          ).toThrow("invalid callback");
          const intercepted = vi.fn();
          const composed = dispatcher.compose((dispatch) => (request, handler) => {
            intercepted();
            return dispatch(request, handler);
          });
          for (const bypass of ["", TARGET_HOST, ""]) {
            vi.stubEnv("no_proxy", bypass);
            const response = await composed.request(mediaRequest);
            expect(await readProxyPayload(new UndiciResponse(response.body))).toBe(PAYLOAD);
          }
          expect(originRoutes).toEqual(routes);
          expect(intercepted).toHaveBeenCalledTimes(3);
          const completion = vi.fn();
          const closing = new Promise<void>((resolve, reject) => {
            dispatcher[method]((error?: Error | null) => {
              completion(error);
              if (error) {
                reject(error);
              } else {
                resolve();
              }
            });
          });
          await Promise.all([closing, dispatcher[method]()]);
          expect(completion).toHaveBeenCalledExactlyOnceWith(null);
          expect(dispatcher).toMatchObject({ destroyed: true, closed: method === "close" });
          await dispatcher.destroy();
          await expect(dispatcher.close()).rejects.toMatchObject({ code: "UND_ERR_DESTROYED" });
          await expect(undiciFetch(HTTP_URL, { dispatcher })).rejects.toMatchObject({
            cause: { code: "UND_ERR_DESTROYED" },
          });
          expect(originRoutes).toEqual(routes);
          await waitForSocketsClosed();
        } finally {
          await dispatcher.destroy();
          vi.unstubAllEnvs();
        }
      },
    );
  },
);

it("preserves target and redirect policy when trusted SOCKS owns DNS", () =>
  withProxyFixture(async ({ socksProxy, connections, certificate }) => {
    const lookupFn = vi.fn(async (hostname: string) => {
      if (hostname === "127.0.0.1") {
        return [{ address: hostname, family: 4 }];
      }
      throw Object.assign(new Error("target DNS unavailable"), { code: "EAI_AGAIN" });
    });
    const options = {
      mode: "trusted_explicit_proxy" as const,
      dispatcherPolicy: {
        mode: "explicit-proxy" as const,
        proxyUrl: socksProxy,
        allowPrivateProxy: true,
        proxyTls: { ca: certificate },
      },
      policy: { hostnameAllowlist: [TARGET_HOST] },
      lookupFn,
      timeoutMs: 5_000,
    };
    const result = await fetchWithSsrFGuard({ ...options, url: TARGET_URL });
    try {
      expect((await readResponseWithLimit(result.response, PAYLOAD_BYTES)).toString("utf8")).toBe(
        PAYLOAD,
      );
    } finally {
      await result.release();
    }
    for (const url of [
      "https://outside.proxy.test/media",
      "https://127.0.0.1/media",
      `https://${TARGET_HOST}/redirect`,
    ]) {
      await expect(fetchWithSsrFGuard({ ...options, url })).rejects.toThrow("not in allowlist");
    }
    for (const overrides of [
      { url: "https://127.0.0.1/media", policy: undefined },
      {
        url: TARGET_URL,
        dispatcherPolicy: { ...options.dispatcherPolicy, allowPrivateProxy: false },
      },
    ]) {
      await expect(fetchWithSsrFGuard({ ...options, ...overrides })).rejects.toThrow(
        /private|internal/i,
      );
    }
    expect(lookupFn.mock.calls.every(([hostname]) => hostname === "127.0.0.1")).toBe(true);
    expect(connections).toEqual([`socks:${TARGET_HOST}`, `socks:${TARGET_HOST}`]);
  }));

it("does not widen strict-mode SOCKS proxy policy", () =>
  withProxyFixture(async ({ socksProxy, connections }) => {
    await expect(
      fetchWithSsrFGuard({
        url: TARGET_URL,
        dispatcherPolicy: {
          mode: "explicit-proxy",
          proxyUrl: socksProxy,
          allowPrivateProxy: true,
        },
      }),
    ).rejects.toThrow("Explicit proxy URL must use http or https");
    expect(connections).toEqual([]);
  }));
