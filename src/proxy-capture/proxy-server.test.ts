// Proxy capture server tests cover request recording and response handling.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  request as httpRequest,
  createServer as createHttpServer,
  type IncomingMessage,
} from "node:http";
import net, { Socket, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { DebugProxySettings } from "./env.js";
import { startDebugProxyServer } from "./proxy-server.js";
import { closeDebugProxyCaptureStore, getDebugProxyCaptureStore } from "./store.sqlite.js";

let testRoot: string | undefined;
const originalStateDir = process.env.OPENCLAW_STATE_DIR;

async function cleanupTestRoot(): Promise<void> {
  closeDebugProxyCaptureStore();
  closeOpenClawStateDatabaseForTest();
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  if (!testRoot) {
    return;
  }
  const root = testRoot;
  testRoot = undefined;
  await rm(root, { recursive: true, force: true });
}

async function makeSettings(): Promise<DebugProxySettings> {
  testRoot = await mkdtemp(join(tmpdir(), "openclaw-debug-proxy-server-"));
  const certDir = join(testRoot, "certs");
  await mkdir(certDir, { recursive: true });
  await writeFile(join(certDir, "root-ca.pem"), "test root cert\n", "utf8");
  await writeFile(join(certDir, "root-ca-key.pem"), "test root key\n", "utf8");
  process.env.OPENCLAW_STATE_DIR = testRoot;
  return {
    enabled: true,
    required: false,
    dbPath: join(testRoot, "capture.sqlite"),
    blobDir: join(testRoot, "blobs"),
    certDir,
    sessionId: "debug-proxy-server-test",
    sourceProcess: "test",
  };
}

async function startLargeBodyOrigin(responseBody: string): Promise<{
  receivedRequestBody: () => string;
  responseBody: string;
  stop: () => Promise<void>;
  url: string;
}> {
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
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    receivedRequestBody: () => receivedBody,
    responseBody,
    stop: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    url: `http://127.0.0.1:${address.port}/capture`,
  };
}

async function startResponseErrorOrigin(): Promise<{
  stop: () => Promise<void>;
  url: string;
}> {
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
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    stop: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    url: `http://127.0.0.1:${address.port}`,
  };
}

type ProxyResponseResult = {
  body: string;
  complete: boolean;
  errorMessage?: string;
  statusCode?: number;
};

async function getThroughProxy(proxyUrl: string, targetUrl: string): Promise<ProxyResponseResult> {
  const proxy = new URL(proxyUrl);
  return await new Promise<ProxyResponseResult>((resolve) => {
    let settled = false;
    let body = "";
    let response: IncomingMessage | undefined;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
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
        method: "GET",
        path: targetUrl,
        headers: { connection: "close" },
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
    req.end();
  });
}

async function postThroughProxy(params: {
  body: string;
  proxyUrl: string;
  targetUrl: string;
}): Promise<string> {
  const proxy = new URL(params.proxyUrl);
  return await new Promise<string>((resolve, reject) => {
    const req = httpRequest(
      {
        host: proxy.hostname,
        port: Number(proxy.port),
        method: "POST",
        path: params.targetUrl,
        headers: {
          connection: "close",
          "content-length": Buffer.byteLength(params.body),
          "content-type": "text/plain; charset=utf-8",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      },
    );
    req.on("error", reject);
    req.end(params.body);
  });
}

async function openConnectClient(proxyUrl: string, connectTarget: string): Promise<Socket> {
  const proxy = new URL(proxyUrl);
  const socket = new Socket();
  socket.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.connect(Number(proxy.port), proxy.hostname, () => {
      socket.off("error", reject);
      resolve();
    });
  });
  socket.write(`CONNECT ${connectTarget} HTTP/1.1\r\nHost: ${connectTarget}\r\n\r\n`);
  return socket;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTestRoot();
});

describe("startDebugProxyServer", () => {
  it("caps UTF-8 previews on character boundaries while forwarding full bodies", async () => {
    const settings = await makeSettings();
    const origin = await startLargeBodyOrigin(`${"r".repeat(8191)}😀tail`);
    const proxy = await startDebugProxyServer({ settings });
    const requestBody = `${"q".repeat(8191)}étail`;

    try {
      const responseBody = await postThroughProxy({
        body: requestBody,
        proxyUrl: proxy.proxyUrl,
        targetUrl: origin.url,
      });

      expect(origin.receivedRequestBody()).toBe(requestBody);
      expect(responseBody).toBe(origin.responseBody);
      const events = getDebugProxyCaptureStore().getSessionEvents(settings.sessionId, 10);
      const capturedRequest = events.find((event) => event.kind === "request");
      const capturedResponse = events.find((event) => event.kind === "response");
      expect(capturedRequest?.dataText).toBe("q".repeat(8191));
      expect(capturedResponse?.dataText).toBe("r".repeat(8191));
      expect(JSON.parse(String(capturedRequest?.metaJson))).toMatchObject({
        bodyBytes: Buffer.byteLength(requestBody),
        capturePreviewBytes: 8192,
        captureTruncated: true,
      });
      expect(JSON.parse(String(capturedResponse?.metaJson))).toMatchObject({
        bodyBytes: Buffer.byteLength(origin.responseBody),
        capturePreviewBytes: 8192,
        captureTruncated: true,
      });
    } finally {
      await proxy.stop();
      await origin.stop();
    }
  });

  it("returns a complete 502 and survives an upstream failure before response headers", async () => {
    const settings = await makeSettings();
    const origin = await startResponseErrorOrigin();
    const proxy = await startDebugProxyServer({ settings });

    try {
      const failed = await getThroughProxy(proxy.proxyUrl, `${origin.url}/before-headers`);
      expect(failed).toMatchObject({
        body: "Bad Gateway\n",
        complete: true,
        statusCode: 502,
      });

      const healthy = await getThroughProxy(proxy.proxyUrl, `${origin.url}/healthy`);
      expect(healthy).toMatchObject({ body: "ok", complete: true, statusCode: 200 });
      expect(getDebugProxyCaptureStore().getSessionEvents(settings.sessionId, 20)).toContainEqual(
        expect.objectContaining({ direction: "local", kind: "error" }),
      );
    } finally {
      await proxy.stop();
      await origin.stop();
    }
  });

  it("aborts a partial response after headers and survives the upstream stream error", async () => {
    const settings = await makeSettings();
    const origin = await startResponseErrorOrigin();
    const proxy = await startDebugProxyServer({ settings });

    try {
      const failed = await getThroughProxy(proxy.proxyUrl, `${origin.url}/after-headers`);
      expect(failed).toMatchObject({
        body: "partial",
        complete: false,
        statusCode: 200,
      });
      expect(failed.errorMessage).toBeDefined();

      const healthy = await getThroughProxy(proxy.proxyUrl, `${origin.url}/healthy`);
      expect(healthy).toMatchObject({ body: "ok", complete: true, statusCode: 200 });
      expect(getDebugProxyCaptureStore().getSessionEvents(settings.sessionId, 20)).toContainEqual(
        expect.objectContaining({ direction: "inbound", kind: "error" }),
      );
    } finally {
      await proxy.stop();
      await origin.stop();
    }
  });

  it("returns 504 when a CONNECT upstream opening attempt times out", async () => {
    const settings = await makeSettings();
    const stalledUpstream = new Socket();
    const setOpeningTimeout = vi.spyOn(stalledUpstream, "setTimeout");
    let resolveConnectCalled!: (target: { hostname: string; port: number }) => void;
    const connectCalled = new Promise<{ hostname: string; port: number }>((resolve) => {
      resolveConnectCalled = resolve;
    });
    vi.spyOn(net, "connect").mockImplementation(((port: number, hostname: string) => {
      resolveConnectCalled({ hostname, port });
      return stalledUpstream;
    }) as typeof net.connect);
    const proxy = await startDebugProxyServer({ settings });
    let client: Socket | undefined;

    try {
      const connectedClient = await openConnectClient(proxy.proxyUrl, "unreachable.example:443");
      client = connectedClient;
      let response = "";
      connectedClient.setEncoding("utf8");
      connectedClient.on("data", (chunk) => {
        response += chunk.toString();
      });
      const clientClosed = new Promise<void>((resolve) => {
        connectedClient.once("close", resolve);
      });

      await expect(connectCalled).resolves.toMatchObject({
        hostname: "unreachable.example",
        port: 443,
      });
      expect(setOpeningTimeout).toHaveBeenCalledWith(30_000, expect.any(Function));
      stalledUpstream.emit("timeout");
      await clientClosed;

      expect(response).toContain("504 Gateway Timeout");
      expect(response).toContain("Gateway Timeout\n");
      expect(stalledUpstream.destroyed).toBe(true);
      expect(getDebugProxyCaptureStore().getSessionEvents(settings.sessionId, 10)).toContainEqual(
        expect.objectContaining({
          direction: "local",
          errorText: "CONNECT upstream timed out after 30000ms",
          kind: "error",
          protocol: "connect",
        }),
      );
    } finally {
      client?.destroy();
      stalledUpstream.destroy();
      await proxy.stop();
    }
  });

  it("removes the CONNECT opening timeout after the upstream socket connects", async () => {
    const settings = await makeSettings();
    const upstream = new Socket();
    const disableTimeout = vi.spyOn(upstream, "setTimeout");
    let resolveConnectCalled!: () => void;
    const connectCalled = new Promise<void>((resolve) => {
      resolveConnectCalled = resolve;
    });
    vi.spyOn(net, "connect").mockImplementation(((
      _port: number,
      _hostname: string,
      onConnect: () => void,
    ) => {
      resolveConnectCalled();
      upstream.once("connect", onConnect);
      return upstream;
    }) as typeof net.connect);
    const proxy = await startDebugProxyServer({ settings });
    let client: Socket | undefined;

    try {
      client = await openConnectClient(proxy.proxyUrl, "example.com:443");
      await connectCalled;
      upstream.emit("connect");

      expect(disableTimeout).toHaveBeenCalledWith(0);
      expect(upstream.listenerCount("timeout")).toBe(0);
    } finally {
      client?.destroy();
      upstream.destroy();
      await proxy.stop();
    }
  });
});
