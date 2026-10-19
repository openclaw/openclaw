import { mkdtemp, rm } from "node:fs/promises";
import {
  request as httpRequest,
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
} from "node:http";
import net, { Socket, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
};

async function getThroughProxy(
  proxyUrl: string,
  targetUrl: string,
  requestBody?: string,
): Promise<ProxyResponseResult> {
  const proxy = new URL(proxyUrl);
  return await new Promise<ProxyResponseResult>((resolve) => {
    let body = "";
    let response: IncomingMessage | undefined;
    const finish = (error?: Error) => {
      resolve({
        body,
        complete: response?.complete ?? false,
        ...(error ? { errorMessage: error.message } : {}),
        ...(response?.statusCode === undefined ? {} : { statusCode: response.statusCode }),
      });
    };
    const req = httpRequest(
      {
        host: proxy.hostname,
        port: Number(proxy.port),
        method: requestBody === undefined ? "GET" : "POST",
        path: targetUrl,
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
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
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
    req.end(requestBody);
  });
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

async function rawSlowGetThroughProxy(params: {
  abortAfterBytes?: number;
  abortWithReset?: boolean;
  onResume?: () => void;
  pauseBeforeReadMs: number;
  proxyUrl: string;
  targetUrl: string;
}): Promise<{
  aborted: boolean;
  bodyBytes: number;
  resumed: boolean;
  statusLine: string;
}> {
  const proxy = new URL(params.proxyUrl);
  return await new Promise((resolve, reject) => {
    let aborted = false;
    let bodyBytes = 0;
    let contentLength: number | undefined;
    let headerBytes = Buffer.alloc(0);
    let resumed = false;
    let statusLine = "";
    let resumeTimeout: ReturnType<typeof setTimeout> | undefined;
    const socket = net.connect(Number(proxy.port), proxy.hostname);
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("slow proxy client timed out"));
    }, 15000);
    const finish = () => {
      clearTimeout(timeout);
      clearTimeout(resumeTimeout);
      resolve({ aborted, bodyBytes, resumed, statusLine });
    };
    const maybeFinishCompleteBody = () => {
      if (contentLength !== undefined && bodyBytes >= contentLength) {
        socket.destroy();
        finish();
      }
    };
    socket.on("connect", () => {
      socket.write(
        `GET ${params.targetUrl} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
      );
      socket.pause();
      resumeTimeout = setTimeout(() => {
        resumed = true;
        params.onResume?.();
        socket.resume();
      }, params.pauseBeforeReadMs);
    });
    socket.on("data", (chunk) => {
      if (contentLength === undefined) {
        headerBytes = Buffer.concat([headerBytes, Buffer.from(chunk)]);
        const headerEnd = headerBytes.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          return;
        }
        const headerText = headerBytes.subarray(0, headerEnd).toString("latin1");
        statusLine = headerText.split("\r\n")[0] ?? "";
        const contentLengthHeader = headerText
          .split("\r\n")
          .find((line) => line.toLowerCase().startsWith("content-length:"));
        const parsedContentLength = Number(contentLengthHeader?.split(":")[1]?.trim());
        contentLength = Number.isFinite(parsedContentLength) ? parsedContentLength : 0;
        bodyBytes += headerBytes.byteLength - headerEnd - 4;
        headerBytes = Buffer.alloc(0);
      } else {
        bodyBytes += chunk.length;
      }
      if (params.abortAfterBytes !== undefined && bodyBytes >= params.abortAfterBytes) {
        aborted = true;
        if (params.abortWithReset) {
          socket.resetAndDestroy();
        } else {
          socket.destroy();
        }
        finish();
        return;
      }
      maybeFinishCompleteBody();
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      clearTimeout(resumeTimeout);
      reject(error);
    });
    socket.on("close", finish);
  });
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
    let queuedBytesAtResume = 0;

    const forwarded = await rawSlowGetThroughProxy({
      onResume: () => {
        queuedBytesAtResume = origin.state.queuedBytes;
      },
      pauseBeforeReadMs: 150,
      proxyUrl: proxy.proxyUrl,
      targetUrl: `${origin.url}/capture`,
    });

    expect(forwarded).toMatchObject({
      aborted: false,
      bodyBytes: responseBodyBytes,
      resumed: true,
      statusLine: "HTTP/1.1 200 OK",
    });
    expect(queuedBytesAtResume).toBeLessThan(responseBodyBytes);
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
      const aborted = await rawSlowGetThroughProxy({
        abortAfterBytes: 64 * 1024,
        abortWithReset,
        pauseBeforeReadMs: 0,
        proxyUrl: proxy.proxyUrl,
        targetUrl: `${origin.url}/capture`,
      });

      expect(aborted).toMatchObject({
        aborted: true,
        resumed: true,
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
