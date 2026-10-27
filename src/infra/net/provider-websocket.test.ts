import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import net, { type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "../../../packages/gateway-client/src/websocket.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../../test/helpers/tls-fixture.js";
import { openProviderWebSocket } from "./provider-websocket.js";
import * as ssrf from "./ssrf.js";

const cleanups: Array<() => Promise<void>> = [];
const providerUrl = "wss://provider.example/audio";
const ignoredError = () => {};
const peerClosed = (peer: Duplex) =>
  once(peer, "close", { signal: AbortSignal.timeout(2000) }).then(
    () => "closed",
    (error: unknown) => error,
  );
const terminateOnOpen = (socket: Awaited<ReturnType<typeof openProviderWebSocket>>) => {
  socket.on("error", ignoredError);
  socket.terminate();
  return socket;
};

function openSocket(
  url: string,
  options: Partial<Parameters<typeof openProviderWebSocket>[0]> = {},
) {
  return openProviderWebSocket({
    url,
    baseUrl: url,
    allowPrivateNetwork: false,
    timeoutMs: 1000,
    trustConfiguredBaseUrlOrigin: false,
    ...options,
  });
}

async function listen(server: ReturnType<typeof createHttpServer>) {
  const connections: net.Socket[] = [];
  server.on("connection", (socket) => connections.push(socket));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(async () => {
    for (const socket of connections) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    connectionCount: () => connections.length,
  };
}

async function createStalledHandshakeServer(event: "upgrade" | "connect") {
  const server = createHttpServer();
  const received = createDeferred<Duplex>();
  server.on(event, (_request, socket) => {
    // Upgraded sockets are half-open: finish our half after the client ends.
    socket.once("end", () => socket.end());
    socket.resume();
    received.resolve(socket);
  });
  const { port, connectionCount } = await listen(server);
  return { url: `http://127.0.0.1:${port}`, received: received.promise, connectionCount };
}

async function prepareProxy(noProxy = "") {
  const proxy = await createStalledHandshakeServer("connect");
  vi.stubEnv("OPENCLAW_PROXY_ACTIVE", undefined);
  for (const name of "HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy".split(
    " ",
  )) {
    vi.stubEnv(name, proxy.url);
  }
  vi.stubEnv("NO_PROXY", noProxy);
  vi.stubEnv("no_proxy", noProxy);
  const resolveHostname = ssrf.resolvePinnedHostnameWithPolicy;
  vi.spyOn(ssrf, "resolvePinnedHostnameWithPolicy").mockImplementation((hostname, params) =>
    resolveHostname(
      hostname,
      hostname === "provider.example"
        ? { ...params, lookupFn: async () => [{ address: "127.0.0.1", family: 4 }] }
        : params,
    ),
  );
  return proxy;
}

async function createLocalWebSocketServer(tls = false) {
  const server = tls
    ? createHttpsServer({ cert: TEST_TLS_CERT_PEM, key: TEST_TLS_KEY_PEM })
    : createHttpServer();
  const websocketServer = new WebSocketServer({ server, maxPayload: 1024 * 1024 });
  let requests = 0;
  server.on("upgrade", () => requests++);
  const { port } = await listen(server);
  cleanups.push(async () => {
    for (const client of websocketServer.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => {
      websocketServer.close(() => resolve());
    });
  });
  return {
    requestCount: () => requests,
    url: `${tls ? "wss" : "ws"}://127.0.0.1:${port}/listen`,
  };
}

async function createConnectProxy(proxyHostname = "127.0.0.1") {
  const server = createHttpServer();
  let connectCount = 0;
  server.on("connect", (request, clientSocket, head) => {
    connectCount += 1;
    const [hostname, rawPort] = (request.url ?? "").split(":");
    const targetSocket = net.connect(Number(rawPort), hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.byteLength > 0) {
        targetSocket.write(head);
      }
      targetSocket.pipe(clientSocket);
      clientSocket.pipe(targetSocket);
    });
  });
  const { port } = await listen(server);
  return { connectCount: () => connectCount, url: `http://${proxyHostname}:${port}` };
}

describe("openProviderWebSocket", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it.each(["explicit-proxy", "env-proxy"] as const)("blocks private DNS via %s", async (mode) => {
    const proxy = await prepareProxy();
    const opening = openSocket(providerUrl, {
      dispatcherPolicy:
        mode === "explicit-proxy"
          ? { mode, proxyUrl: proxy.url, allowPrivateProxy: true }
          : { mode },
    }).then(terminateOnOpen);
    await expect(opening).rejects.toThrow(/private|loopback|blocked/iu);
    expect(proxy.connectionCount()).toBe(0);
  });

  it.each([false, true])("delegates target DNS to ambient proxy (managed=%s)", async (managed) => {
    const proxy = await prepareProxy();
    if (managed) {
      vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
    }
    const socket = await openSocket(providerUrl, {
      dispatcherPolicy: managed ? { mode: "env-proxy" } : undefined,
    });
    socket.on("error", ignoredError);
    const peer = await withTestTimeout(proxy.received, 2000, "Proxy did not receive CONNECT");
    const closed = once(peer, "close", { signal: AbortSignal.timeout(2000) });
    socket.terminate();
    await closed;
    expect(proxy.connectionCount()).toBe(1);
  });

  it.each(["NO_PROXY bypass", "ALL_PROXY only"])("checks target DNS for %s", async (mode) => {
    const proxy = await prepareProxy(mode === "NO_PROXY bypass" ? "provider.example" : "");
    if (mode === "NO_PROXY bypass") {
      vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
    } else {
      for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
        vi.stubEnv(name, undefined);
      }
    }
    const opening = openSocket(providerUrl, {
      dispatcherPolicy: mode === "NO_PROXY bypass" ? { mode: "env-proxy" } : undefined,
    }).then(terminateOnOpen);
    await expect(opening).rejects.toThrow(/private|loopback|blocked/iu);
    expect(proxy.connectionCount()).toBe(0);
  });

  it("keeps DNS preparation and the handshake within one connection deadline", async () => {
    const server = await createStalledHandshakeServer("upgrade");
    const lookupStarted = createDeferred();
    const releaseLookup = createDeferred();
    const resolveHostname = ssrf.resolvePinnedHostnameWithPolicy;
    vi.spyOn(ssrf, "resolvePinnedHostnameWithPolicy").mockImplementationOnce(async (...args) => {
      lookupStarted.resolve();
      await releaseLookup.promise;
      return await resolveHostname(...args);
    });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const url = server.url.replace("http:", "ws:");
    const opening = openSocket(url, {
      allowPrivateNetwork: true,
      dispatcherPolicy: { mode: "direct" },
    });
    await lookupStarted.promise;
    await vi.advanceTimersByTimeAsync(600);
    releaseLookup.resolve();
    const socket = await opening;
    const errors: Error[] = [];
    socket.on("error", (error) => errors.push(error));
    const peer = await server.received;
    const closed = peerClosed(peer);
    await vi.advanceTimersByTimeAsync(399);
    expect(socket.readyState).toBe(socket.CONNECTING);
    await vi.advanceTimersByTimeAsync(1);
    expect(errors).toHaveLength(1);
    expect(await closed).toBe("closed");
  });

  it.each(["deadline", "abort", "terminate"])("closes stalled CONNECT on %s", async (stop) => {
    const proxy = await createStalledHandshakeServer("connect");
    const controller = new AbortController();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const socket = await openSocket("wss://127.0.0.1/audio", {
      allowPrivateNetwork: true,
      dispatcherPolicy: { mode: "explicit-proxy", proxyUrl: proxy.url },
      signal: controller.signal,
    });
    socket.on("error", ignoredError);
    const peer = await proxy.received;
    const closed = peerClosed(peer);
    if (stop === "deadline") {
      await vi.advanceTimersByTimeAsync(1000);
    } else if (stop === "abort") {
      controller.abort();
    } else {
      socket.terminate();
    }
    expect(socket.readyState).not.toBe(socket.CONNECTING);
    expect(await closed).toBe("closed");
  });

  it.each([false, true])("does not open a socket (pre-aborted=%s)", async (aborted) => {
    const server = await createLocalWebSocketServer();
    await expect(
      openSocket(server.url, {
        allowPrivateNetwork: aborted,
        headers: { authorization: "Token test" },
        ...(aborted ? { signal: AbortSignal.abort() } : {}),
      }),
    ).rejects.toThrow(/private|loopback|blocked|aborted/iu);
    expect(server.requestCount()).toBe(0);
  });

  it.each([false, true])("opens handshake with transport settings (proxy=%s)", async (useProxy) => {
    const target = await createLocalWebSocketServer(!useProxy);
    const connectSpy = vi.spyOn(net, "connect");
    const proxy = useProxy ? await createConnectProxy("localhost") : undefined;
    const socket = await openSocket(target.url, {
      allowPrivateNetwork: true,
      dispatcherPolicy: proxy
        ? { mode: "explicit-proxy", proxyUrl: proxy.url }
        : { mode: "direct", connect: { rejectUnauthorized: false } },
    });
    await once(socket, "open");
    expect(target.requestCount()).toBe(1);
    if (proxy) {
      expect(proxy.connectCount()).toBe(1);
      expect(
        connectSpy.mock.calls.some(
          ([options]) => typeof asOptionalRecord(options)?.lookup === "function",
        ),
      ).toBe(true);
    }
    socket.close();
    await once(socket, "close");
  });
});
