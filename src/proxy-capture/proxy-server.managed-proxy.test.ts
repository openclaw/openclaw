import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { Socket, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import type { DebugProxySettings } from "./env.js";
import { startDebugProxyServer } from "./proxy-server.js";

vi.mock("./ca.js", () => ({
  ensureDebugProxyCa: async () => ({ certPath: "test", keyPath: "test" }),
}));

let testRoot: string | undefined;

async function cleanupTestDirs(): Promise<void> {
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
  testRoot = await mkdtemp(join(tmpdir(), "openclaw-debug-proxy-managed-proxy-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", testRoot);
  return {
    enabled: true,
    required: false,
    dbPath: join(testRoot, "capture.sqlite"),
    blobDir: join(testRoot, "blobs"),
    certDir: join(testRoot, "certs"),
    sessionId: "debug-proxy-managed-proxy-test",
    sourceProcess: "test",
  };
}

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
  const server = createHttpServer((_req, res) => {
    requests += 1;
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
    requestCount: () => requests,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    url: `http://127.0.0.1:${address.port}/metadata`,
  };
}

describe("debug proxy managed-proxy direct upstream policy", () => {
  let activeServer: Awaited<ReturnType<typeof startDebugProxyServer>> | undefined;
  let origin: Awaited<ReturnType<typeof startCanaryOrigin>> | undefined;
  const startProxy = async () =>
    (activeServer = await startDebugProxyServer({ settings: await makeSettings() }));

  beforeEach(async () => {
    await cleanupTestDirs();
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", undefined);
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ALLOW_DIRECT_CONNECT_WITH_MANAGED_PROXY", undefined);
  });

  afterEach(async () => {
    await activeServer?.stop();
    await origin?.stop();
    activeServer = undefined;
    origin = undefined;
    await cleanupTestDirs();
  });

  it("allows HTTP upstreams with the explicit diagnostic override", async () => {
    process.env["OPENCLAW_PROXY_ACTIVE"] = "1";
    process.env["OPENCLAW_DEBUG_PROXY_ALLOW_DIRECT_CONNECT_WITH_MANAGED_PROXY"] = "1";
    origin = await startCanaryOrigin();
    const server = await startProxy();
    const response = await requestThroughProxy(server.proxyUrl, origin.url);

    expect(response).toContain("200 OK");
    expect(response).toContain("ok");
    expect(origin.requestCount()).toBe(1);
  });

  it("rejects CONNECT upstreams before opening direct sockets while managed proxy mode is active", async () => {
    process.env["OPENCLAW_PROXY_ACTIVE"] = "true";
    const server = await startDebugProxyServer({ settings: await makeSettings() });
    try {
      const response = await connectThroughProxy(server.proxyUrl);

      expect(response).toContain("403 Forbidden");
      expect(response).toContain("Connection: close");
      expect(response).toContain("Debug proxy direct upstream forwarding is disabled");
    } finally {
      await server.stop();
    }
  });

  it("accepts bracketed IPv6 CONNECT targets before applying upstream policy", async () => {
    process.env["OPENCLAW_PROXY_ACTIVE"] = "1";
    const server = await startProxy();
    const response = await connectThroughProxy(server.proxyUrl, "[::1]:8443");

    expect(response).toContain("403 Forbidden");
    expect(response).not.toContain("400 Bad Request");
  });

  it.each(["[::1]:99999", "api.openai.com:1e3", "api.openai.com:0x50"])(
    "rejects invalid CONNECT target %s",
    async (connectTarget) => {
      const server = await startProxy();
      const response = await connectThroughProxy(server.proxyUrl, connectTarget);

      expect(response).toContain("400 Bad Request");
    },
  );

  it("rejects absolute-form HTTP proxy requests before opening direct upstreams while managed proxy mode is active", async () => {
    process.env["OPENCLAW_PROXY_ACTIVE"] = "1";
    origin = await startCanaryOrigin();
    const server = await startProxy();
    const response = await requestThroughProxy(server.proxyUrl, origin.url);

    expect(response).toContain("403 Forbidden");
    expect(response).toContain("Connection: close");
    expect(response).toContain("Debug proxy direct upstream forwarding is disabled");
    expect(origin.requestCount()).toBe(0);
  });

  it("rejects malformed relative-form HTTP proxy targets before upstream handling", async () => {
    const server = await startProxy();
    const response = await requestRawThroughProxy(
      server.proxyUrl,
      "GET /capture HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n",
    );

    expect(response).toContain("400 Bad Request");
    expect(response).toContain("Connection: close");
    expect(response).toContain("Invalid proxy target URL");
  });
});
