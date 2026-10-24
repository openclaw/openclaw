import { mkdtemp, rm } from "node:fs/promises";
import {
  request as httpRequest,
  createServer as createHttpServer,
  IncomingMessage,
  ServerResponse,
  type Server,
} from "node:http";
import net, { Socket, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import type { DebugProxySettings } from "./env.js";
import { startDebugProxyServer } from "./proxy-server.js";
import { createDebugProxyCaptureReaderAsync } from "./store-readonly.async.js";

vi.mock("./ca.js", () => ({
  ensureDebugProxyCa: async () => ({ certPath: "test", keyPath: "test" }),
}));

let testRoot: string | undefined;
const cleanup: Array<() => void | Promise<void>> = [];

async function startProxy() {
  const settings = await makeSettings();
  const proxy = await startDebugProxyServer({ settings });
  cleanup.push(proxy.stop);
  return { settings, proxy };
}

async function cleanupTestRoot(): Promise<void> {
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
  if (!testRoot) {
    return;
  }
  const root = testRoot;
  testRoot = undefined;
  await rm(root, { recursive: true, force: true });
}

async function makeSettings(): Promise<DebugProxySettings> {
  testRoot = await mkdtemp(join(tmpdir(), "openclaw-debug-proxy-server-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", testRoot);
  return {
    enabled: true,
    required: false,
    dbPath: join(testRoot, "capture.sqlite"),
    blobDir: join(testRoot, "blobs"),
    certDir: join(testRoot, "certs"),
    sessionId: "debug-proxy-server-test",
    sourceProcess: "test",
  };
}

function readCaptureEvents(sessionId: string, limit: number) {
  return createDebugProxyCaptureReaderAsync({ env: process.env }).getSessionEvents(
    sessionId,
    limit,
  );
}

async function listenOrigin(server: Server, path = "") {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const stop = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  cleanup.push(stop);
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`,
  };
}

async function startLargeBodyOrigin(responseBody: string) {
  let receivedBody = "";
  const server = createHttpServer((req, res) => {
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      receivedBody += chunk;
    });
    req.on("end", () => {
      res.writeHead(200, {
        "content-length": Buffer.byteLength(responseBody),
        "content-type": "text/plain; charset=utf-8",
      });
      res.end(responseBody);
    });
  });
  return {
    ...(await listenOrigin(server, "/capture")),
    receivedRequestBody: () => receivedBody,
    responseBody,
  };
}

async function startResponseErrorOrigin() {
  const server = createHttpServer((req, res) => {
    if (req.url === "/before-headers") {
      res.socket?.destroy();
      return;
    }
    if (req.url === "/after-headers") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.flushHeaders();
      res.write("partial");
      setTimeout(() => res.socket?.destroy(), 50);
      return;
    }
    res.writeHead(200, {
      "content-length": 2,
      "content-type": "text/plain; charset=utf-8",
    });
    res.end("ok");
  });
  return listenOrigin(server);
}

type ProxyResponseResult = {
  body: string;
  complete: boolean;
  errorMessage?: string;
  statusCode?: number;
  statusLine?: string;
};

function captureMethodCall<Key extends PropertyKey, Args extends unknown[], Result>(
  owner: Record<Key, (...args: Args) => Result>,
  key: Key,
) {
  const method = owner[key];
  return (receiver: typeof owner, ...args: Args): Result => method.apply(receiver, args);
}

type ProxyClientOptions = {
  abortAfterBytes?: number;
  abortWithReset?: boolean;
  signal?: AbortSignal;
  streaming?: boolean;
};

async function getThroughProxy(
  proxyUrl: string,
  targetUrl: string,
  requestBody?: string,
  options: ProxyClientOptions = {},
) {
  const proxy = new URL(proxyUrl);
  return new Promise<ProxyResponseResult & { aborted: boolean; bodyBytes: number }>(
    (resolve, reject) => {
      const chunks: Buffer[] = [];
      let response: IncomingMessage | undefined;
      let aborted = false,
        bodyBytes = 0;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        if (error && options.streaming && !aborted) {
          reject(error);
        } else {
          resolve({
            body: Buffer.concat(chunks).toString(),
            complete: response?.complete ?? false,
            statusCode: response?.statusCode,
            statusLine:
              response &&
              `HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}`,
            errorMessage: error?.message,
            aborted,
            bodyBytes,
          });
        }
      };
      const abort = () => {
        aborted = true;
        if (options.abortWithReset && response?.socket) {
          response.socket.resetAndDestroy();
        } else {
          req.destroy();
        }
        finish();
      };
      const req = httpRequest(
        {
          hostname: proxy.hostname,
          port: proxy.port,
          path: targetUrl,
          method: requestBody === undefined ? "GET" : "POST",
          headers: {
            connection: "close",
            ...(requestBody === undefined
              ? {}
              : {
                  "content-length": Buffer.byteLength(requestBody),
                  "content-type": "text/plain; charset=utf-8",
                }),
          },
        },
        (res) => {
          response = res;
          res.on("data", (chunk: Buffer) => {
            bodyBytes += chunk.length;
            if (!options.streaming) {
              chunks.push(chunk);
            }
            if (options.abortAfterBytes !== undefined && bodyBytes >= options.abortAfterBytes) {
              abort();
            }
          });
          res.on("end", () => finish());
          res.on("error", finish);
          res.on("close", () => {
            if (!res.complete) {
              finish(new Error("response closed before completion"));
            }
          });
        },
      );
      req.on("error", finish);
      if (options.streaming) {
        timeout = setTimeout(() => {
          req.destroy();
          finish(new Error("slow proxy client timed out"));
        }, 15000);
      }
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) {
        abort();
      }
      req.end(requestBody);
    },
  );
}

async function startStreamingProxyOrigin(responseBodyBytes: number) {
  const state = {
    closedResponses: 0,
    drainWaits: 0,
    finishedResponses: 0,
    queuedBytes: 0,
  };
  const responseClosed = createDeferredCore();
  const chunk = Buffer.alloc(64 * 1024, "x");
  const server = createHttpServer((req, res) => {
    req.resume();
    if (req.url === "/healthy") {
      res.writeHead(200, {
        "content-length": 2,
        "content-type": "text/plain; charset=utf-8",
      });
      res.end("ok");
      return;
    }

    res.writeHead(200, {
      "content-length": responseBodyBytes,
      "content-type": "text/plain; charset=utf-8",
    });
    res.on("close", () => {
      state.closedResponses++;
      responseClosed.resolve();
    });
    res.on("finish", () => {
      state.finishedResponses++;
    });

    const writeNextChunk = () => {
      while (state.queuedBytes < responseBodyBytes && !res.destroyed) {
        const chunkBytes = Math.min(chunk.byteLength, responseBodyBytes - state.queuedBytes);
        state.queuedBytes += chunkBytes;
        if (!res.write(chunk.subarray(0, chunkBytes))) {
          state.drainWaits++;
          res.once("drain", writeNextChunk);
          return;
        }
      }
      if (state.queuedBytes === responseBodyBytes && !res.destroyed) {
        res.end();
      }
    };
    writeNextChunk();
  });

  return {
    ...(await listenOrigin(server)),
    responseClosed: responseClosed.promise,
    state,
  };
}

async function startConnectProxy(connectTarget: string) {
  const upstream = new Socket();
  const openingTimeout = vi.spyOn(upstream, "setTimeout");
  const connected = createDeferredCore<{ hostname: string; port: number }>();
  vi.spyOn(net, "connect").mockImplementation(((
    port: number,
    hostname: string,
    onConnect: () => void,
  ) => {
    connected.resolve({ hostname, port });
    upstream.once("connect", onConnect);
    return upstream;
  }) as typeof net.connect);
  const { settings, proxy } = await startProxy();
  cleanup.push(() => {
    upstream.destroy();
  });
  const address = new URL(proxy.proxyUrl);
  const socket = new Socket();
  cleanup.push(() => {
    socket.destroy();
  });
  socket.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.connect(Number(address.port), address.hostname, () => {
      socket.off("error", reject);
      resolve();
    });
  });
  socket.write(`CONNECT ${connectTarget} HTTP/1.1\r\nHost: ${connectTarget}\r\n\r\n`);
  return {
    settings,
    proxy,
    upstream,
    client: socket,
    connected: connected.promise,
    openingTimeout,
  };
}

afterEach(async () => {
  for (const stop of cleanup.splice(0).toReversed()) {
    await stop();
  }
  vi.restoreAllMocks();
  await cleanupTestRoot();
});

describe("startDebugProxyServer", () => {
  it("caps UTF-8 previews on character boundaries while forwarding full bodies", async () => {
    const origin = await startLargeBodyOrigin(`${"r".repeat(8191)}😀tail`);
    const { settings, proxy } = await startProxy();
    const requestBody = `${"q".repeat(8191)}étail`;

    const response = await getThroughProxy(proxy.proxyUrl, origin.url, requestBody);

    expect(origin.receivedRequestBody()).toBe(requestBody);
    expect(response.body).toBe(origin.responseBody);
    expect(response.complete).toBe(true);
    await proxy.stop();
    const events = await readCaptureEvents(settings.sessionId, 10);
    for (const { kind, body, prefix } of [
      { kind: "request", body: requestBody, prefix: "q" },
      { kind: "response", body: origin.responseBody, prefix: "r" },
    ]) {
      const event = events.find((candidate) => candidate.kind === kind);
      expect(event?.dataText).toBe(prefix.repeat(8191));
      expect(JSON.parse(String(event?.metaJson))).toMatchObject({
        bodyBytes: Buffer.byteLength(body),
        capturePreviewBytes: 8192,
        captureTruncated: true,
      });
    }
  });

  it("pauses the upstream response while downstream forwarding is backpressured", async () => {
    const responseBodyBytes = 16 * 1024 * 1024;
    const origin = await startStreamingProxyOrigin(responseBodyBytes);
    const { settings, proxy } = await startProxy();
    const targetUrl = `${origin.url}/capture`;
    const originPort = Number(new URL(origin.url).port);
    const abortController = new AbortController();
    const firstDrain = createDeferredCore();
    let isUpstreamPaused: (() => boolean) | undefined;
    let waitingForDrain = false;
    let bytesReadWhileBackpressured = 0;
    const drainStates: { pausedBefore: boolean | undefined; pausedAfter: boolean | undefined }[] =
      [];
    const callOn = captureMethodCall<
      "on",
      Parameters<IncomingMessage["on"]>,
      ReturnType<IncomingMessage["on"]>
    >(IncomingMessage.prototype, "on");
    vi.spyOn(IncomingMessage.prototype, "on").mockImplementation(function (
      this: IncomingMessage,
      ...args: Parameters<IncomingMessage["on"]>
    ) {
      if (args[0] === "data" && this.statusCode === 200 && this.socket.remotePort === originPort) {
        isUpstreamPaused = () => this.isPaused();
        // Origin writes include TCP buffering; count bytes at the proxy's reader.
        callOn(this, "data", (chunk: Buffer | string) => {
          if (waitingForDrain) {
            bytesReadWhileBackpressured += Buffer.byteLength(chunk);
          }
        });
      }
      return callOn(this, ...args);
    });
    const callWrite = captureMethodCall<
      "write",
      Parameters<ServerResponse["write"]>,
      ReturnType<ServerResponse["write"]>
    >(ServerResponse.prototype, "write");
    vi.spyOn(ServerResponse.prototype, "write").mockImplementation(function (
      this: ServerResponse,
      ...args: Parameters<ServerResponse["write"]>
    ) {
      const accepted = callWrite(this, ...args);
      if (this.req.url === targetUrl && !accepted) {
        waitingForDrain = true;
      }
      return accepted;
    });
    const callEmit = captureMethodCall<
      "emit",
      Parameters<ServerResponse["emit"]>,
      ReturnType<ServerResponse["emit"]>
    >(ServerResponse.prototype, "emit");
    vi.spyOn(ServerResponse.prototype, "emit").mockImplementation(function (
      this: ServerResponse,
      ...args: Parameters<ServerResponse["emit"]>
    ) {
      if (this.req.url !== targetUrl || args[0] !== "drain" || !waitingForDrain) {
        return callEmit(this, ...args);
      }
      // A later promise callback may already see the next pause/drain cycle.
      const pausedBefore = isUpstreamPaused?.();
      waitingForDrain = false;
      const emitted = callEmit(this, ...args);
      drainStates.push({ pausedBefore, pausedAfter: isUpstreamPaused?.() });
      firstDrain.resolve();
      return emitted;
    });
    const forwarding = getThroughProxy(proxy.proxyUrl, targetUrl, undefined, {
      streaming: true,
      signal: abortController.signal,
    });
    cleanup.push(async () => {
      abortController.abort();
      await Promise.allSettled([forwarding]);
    });
    await Promise.race([firstDrain.promise, forwarding]);
    expect(drainStates[0]).toEqual({ pausedBefore: true, pausedAfter: false });
    const forwarded = await forwarding;

    expect(forwarded).toMatchObject({
      aborted: false,
      bodyBytes: responseBodyBytes,
      statusLine: "HTTP/1.1 200 OK",
    });
    expect(bytesReadWhileBackpressured).toBe(0);
    expect(drainStates.every((state) => state.pausedBefore && !state.pausedAfter)).toBe(true);
    expect(origin.state.drainWaits).toBeGreaterThan(0);
    expect(origin.state.queuedBytes).toBe(responseBodyBytes);
    await proxy.stop();
    const captureEvents = (await readCaptureEvents(settings.sessionId, 20)).filter(
      (event) => event.path === "/capture",
    );
    expect(captureEvents.filter((event) => event.kind === "error")).toEqual([]);
    expect(captureEvents.filter((event) => event.kind === "response")).toEqual([
      expect.objectContaining({ direction: "inbound", status: 200 }),
    ]);
  });

  it.each([false, true])(
    "closes upstream and captures one error on downstream abort (reset=%s)",
    async (abortWithReset) => {
      const responseBodyBytes = 16 * 1024 * 1024;
      const origin = await startStreamingProxyOrigin(responseBodyBytes);
      const { settings, proxy } = await startProxy();

      // Start the async reader before the bounded abort assertions measure cleanup.
      await readCaptureEvents(settings.sessionId, 20);
      const aborted = await getThroughProxy(proxy.proxyUrl, `${origin.url}/capture`, undefined, {
        streaming: true,
        abortAfterBytes: 64 * 1024,
        abortWithReset,
      });

      expect(aborted).toMatchObject({
        aborted: true,
        statusLine: "HTTP/1.1 200 OK",
      });
      expect(aborted.bodyBytes).toBeGreaterThanOrEqual(64 * 1024);

      await origin.responseClosed;
      expect(origin.state.closedResponses).toBe(1);
      expect(origin.state.finishedResponses).toBe(0);

      const healthy = await getThroughProxy(proxy.proxyUrl, `${origin.url}/healthy`);
      expect(healthy).toMatchObject({ body: "ok", complete: true, statusCode: 200 });
      await proxy.stop();
      const events = await readCaptureEvents(settings.sessionId, 20);
      const captureEvents = events.filter((event) => event.path === "/capture");
      const capturedRequest = captureEvents.find((event) => event.kind === "request");
      expect(capturedRequest).toBeDefined();
      expect(captureEvents.filter((event) => event.kind === "error")).toEqual([
        expect.objectContaining({
          direction: "local",
          errorText: abortWithReset
            ? expect.any(String)
            : "Downstream response closed before completion",
          flowId: capturedRequest?.flowId,
        }),
      ]);
      expect(captureEvents.filter((event) => event.kind === "response")).toEqual([]);
      expect(events.filter((event) => event.path === "/healthy" && event.kind === "error")).toEqual(
        [],
      );
    },
  );

  it.each([
    {
      path: "before-headers",
      body: "Bad Gateway\n",
      complete: true,
      statusCode: 502,
      direction: "local",
    },
    {
      path: "after-headers",
      body: "partial",
      complete: false,
      statusCode: 200,
      direction: "inbound",
    },
  ])("survives an upstream failure $path", async ({ path, direction, ...expected }) => {
    const origin = await startResponseErrorOrigin();
    const { settings, proxy } = await startProxy();

    const failed = await getThroughProxy(proxy.proxyUrl, `${origin.url}/${path}`);
    expect(failed).toMatchObject(expected);
    if (!expected.complete) {
      expect(failed.errorMessage).toBeDefined();
    }

    const healthy = await getThroughProxy(proxy.proxyUrl, `${origin.url}/healthy`);
    expect(healthy).toMatchObject({ body: "ok", complete: true, statusCode: 200 });
    await proxy.stop();
    expect(await readCaptureEvents(settings.sessionId, 20)).toContainEqual(
      expect.objectContaining({ direction, kind: "error" }),
    );
  });

  it("returns 504 when a CONNECT upstream opening attempt times out", async () => {
    const { settings, proxy, upstream, client, connected, openingTimeout } =
      await startConnectProxy("unreachable.example:443");
    let response = "";
    client.setEncoding("utf8");
    client.on("data", (chunk) => {
      response += chunk.toString();
    });
    const clientClosed = new Promise<void>((resolve) => {
      client.once("close", resolve);
    });

    await expect(connected).resolves.toMatchObject({
      hostname: "unreachable.example",
      port: 443,
    });
    expect(openingTimeout).toHaveBeenCalledWith(30_000, expect.any(Function));
    upstream.emit("timeout");
    await clientClosed;

    expect(response).toContain("504 Gateway Timeout");
    expect(response).toContain("Gateway Timeout\n");
    expect(upstream.destroyed).toBe(true);
    await proxy.stop();
    expect(await readCaptureEvents(settings.sessionId, 10)).toContainEqual(
      expect.objectContaining({
        direction: "local",
        errorText: "CONNECT upstream opening timed out after 30000ms of inactivity",
        kind: "error",
        protocol: "connect",
      }),
    );
  });

  it("removes the CONNECT opening timeout after the upstream socket connects", async () => {
    const { upstream, connected, openingTimeout } = await startConnectProxy("example.com:443");
    await connected;
    upstream.emit("connect");

    expect(openingTimeout).toHaveBeenCalledWith(0);
    expect(upstream.listenerCount("timeout")).toBe(0);
  });
});

async function connectThroughProxy(
  proxyUrl: string,
  connectTarget = "example.com:443",
): Promise<string> {
  return requestRawThroughProxy(
    proxyUrl,
    `CONNECT ${connectTarget} HTTP/1.1\r\nHost: ${connectTarget}\r\n\r\n`,
  );
}

async function requestThroughProxy(proxyUrl: string, targetUrl: string): Promise<string> {
  const target = new URL(targetUrl);
  return requestRawThroughProxy(
    proxyUrl,
    `GET ${target.href} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`,
  );
}

async function requestRawThroughProxy(proxyUrl: string, request: string): Promise<string> {
  const proxy = new URL(proxyUrl);
  const socket = new Socket();
  let data = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    data += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.connect(Number(proxy.port), proxy.hostname, resolve);
  });
  socket.write(request);
  await new Promise<void>((resolve) => {
    socket.once("end", resolve);
  });
  socket.destroy();
  return data;
}

async function startCanaryOrigin() {
  let requests = 0;
  const origin = await listenOrigin(
    createHttpServer((_req, res) => {
      requests++;
      res.end("ok");
    }),
    "/metadata",
  );
  return { ...origin, requestCount: () => requests };
}

describe("debug proxy managed-proxy direct upstream policy", () => {
  const startManagedProxy = async () => (await startProxy()).proxy;
  let origin: Awaited<ReturnType<typeof startCanaryOrigin>>;

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", undefined);
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ALLOW_DIRECT_CONNECT_WITH_MANAGED_PROXY", undefined);
  });

  it("allows HTTP upstreams with the explicit diagnostic override", async () => {
    process.env["OPENCLAW_PROXY_ACTIVE"] = "1";
    process.env["OPENCLAW_DEBUG_PROXY_ALLOW_DIRECT_CONNECT_WITH_MANAGED_PROXY"] = "1";
    origin = await startCanaryOrigin();
    const server = await startManagedProxy();
    const response = await requestThroughProxy(server.proxyUrl, origin.url);

    expect(response).toContain("200 OK");
    expect(response).toContain("ok");
    expect(origin.requestCount()).toBe(1);
  });

  it("rejects CONNECT upstreams before opening direct sockets while managed proxy mode is active", async () => {
    process.env["OPENCLAW_PROXY_ACTIVE"] = "true";
    const server = await startManagedProxy();
    const response = await connectThroughProxy(server.proxyUrl);
    expect(response).toContain("403 Forbidden");
    expect(response).toContain("Connection: close");
    expect(response).toContain("Debug proxy direct upstream forwarding is disabled");
  });

  it("accepts bracketed IPv6 CONNECT targets before applying upstream policy", async () => {
    process.env["OPENCLAW_PROXY_ACTIVE"] = "1";
    const server = await startManagedProxy();
    const response = await connectThroughProxy(server.proxyUrl, "[::1]:8443");

    expect(response).toContain("403 Forbidden");
    expect(response).not.toContain("400 Bad Request");
  });

  it.each(["[::1]:99999", "api.openai.com:1e3", "api.openai.com:0x50"])(
    "rejects invalid CONNECT target %s",
    async (connectTarget) => {
      const server = await startManagedProxy();
      const response = await connectThroughProxy(server.proxyUrl, connectTarget);

      expect(response).toContain("400 Bad Request");
    },
  );

  it("rejects absolute-form HTTP proxy requests before opening direct upstreams while managed proxy mode is active", async () => {
    process.env["OPENCLAW_PROXY_ACTIVE"] = "1";
    origin = await startCanaryOrigin();
    const server = await startManagedProxy();
    const response = await requestThroughProxy(server.proxyUrl, origin.url);

    expect(response).toContain("403 Forbidden");
    expect(response).toContain("Connection: close");
    expect(response).toContain("Debug proxy direct upstream forwarding is disabled");
    expect(origin.requestCount()).toBe(0);
  });

  it("rejects malformed relative-form HTTP proxy targets before upstream handling", async () => {
    const server = await startManagedProxy();
    const response = await requestRawThroughProxy(
      server.proxyUrl,
      "GET /capture HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n",
    );

    expect(response).toContain("400 Bad Request");
    expect(response).toContain("Connection: close");
    expect(response).toContain("Invalid proxy target URL");
  });
});
