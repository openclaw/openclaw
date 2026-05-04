import { mkdtemp, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertDebugProxyDirectConnectAllowed, startDebugProxyServer } from "./proxy-server.js";

let testRoot: string | undefined;

async function cleanupTestDirs(): Promise<void> {
  if (!testRoot) {
    return;
  }
  const root = testRoot;
  testRoot = undefined;
  await rm(root, { recursive: true, force: true });
}

async function makeSettings() {
  testRoot = await mkdtemp(join(tmpdir(), "openclaw-debug-proxy-managed-proxy-"));
  return {
    enabled: true,
    required: false,
    dbPath: ":memory:",
    blobDir: join(testRoot, "blobs"),
    certDir: join(testRoot, "certs"),
    sessionId: "debug-proxy-managed-proxy-test",
    sourceProcess: "test",
  };
}

async function connectThroughProxy(proxyUrl: string): Promise<string> {
  const target = new URL(proxyUrl);
  const socket = new Socket();
  let data = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    data += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.connect(Number(target.port), target.hostname, resolve);
  });
  socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
  await new Promise<void>((resolve) => socket.once("end", resolve));
  socket.destroy();
  return data;
}

describe("debug proxy managed-proxy CONNECT policy", () => {
  const originalProxyActive = process.env["OPENCLAW_PROXY_ACTIVE"];
  const originalAllowDirect =
    process.env["OPENCLAW_DEBUG_PROXY_ALLOW_DIRECT_CONNECT_WITH_MANAGED_PROXY"];

  beforeEach(async () => {
    await cleanupTestDirs();
    delete process.env["OPENCLAW_PROXY_ACTIVE"];
    delete process.env["OPENCLAW_DEBUG_PROXY_ALLOW_DIRECT_CONNECT_WITH_MANAGED_PROXY"];
  });

  afterEach(async () => {
    if (originalProxyActive === undefined) {
      delete process.env["OPENCLAW_PROXY_ACTIVE"];
    } else {
      process.env["OPENCLAW_PROXY_ACTIVE"] = originalProxyActive;
    }
    if (originalAllowDirect === undefined) {
      delete process.env["OPENCLAW_DEBUG_PROXY_ALLOW_DIRECT_CONNECT_WITH_MANAGED_PROXY"];
    } else {
      process.env["OPENCLAW_DEBUG_PROXY_ALLOW_DIRECT_CONNECT_WITH_MANAGED_PROXY"] =
        originalAllowDirect;
    }
    await cleanupTestDirs();
  });

  it("allows direct CONNECT upstreams when managed proxy mode is inactive", () => {
    expect(() => assertDebugProxyDirectConnectAllowed()).not.toThrow();
  });

  it("rejects direct CONNECT upstreams while managed proxy mode is active", () => {
    process.env["OPENCLAW_PROXY_ACTIVE"] = "1";

    expect(() => assertDebugProxyDirectConnectAllowed()).toThrow(
      /Debug proxy CONNECT upstream forwarding is disabled/,
    );
  });

  it("uses shared truthy parsing for managed proxy mode", () => {
    process.env["OPENCLAW_PROXY_ACTIVE"] = "true";

    expect(() => assertDebugProxyDirectConnectAllowed()).toThrow(
      /Debug proxy CONNECT upstream forwarding is disabled/,
    );
  });

  it("allows direct CONNECT upstreams with explicit diagnostic override", () => {
    process.env["OPENCLAW_PROXY_ACTIVE"] = "1";
    process.env["OPENCLAW_DEBUG_PROXY_ALLOW_DIRECT_CONNECT_WITH_MANAGED_PROXY"] = "1";

    expect(() => assertDebugProxyDirectConnectAllowed()).not.toThrow();
  });

  it("rejects CONNECT upstreams before opening direct sockets while managed proxy mode is active", async () => {
    process.env["OPENCLAW_PROXY_ACTIVE"] = "1";
    const server = await startDebugProxyServer({ settings: await makeSettings() });
    try {
      const response = await connectThroughProxy(server.proxyUrl);

      expect(response).toContain("403 Forbidden");
      expect(response).toContain("Connection: close");
      expect(response).toContain("Debug proxy CONNECT upstream forwarding is disabled");
    } finally {
      await server.stop();
    }
  });
});
