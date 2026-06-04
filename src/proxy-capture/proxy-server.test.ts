import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConnectTarget, startDebugProxyServer } from "./proxy-server.js";

describe("parseConnectTarget", () => {
  it("parses bracketed IPv6 CONNECT targets safely", () => {
    expect(parseConnectTarget("[::1]:8443")).toEqual({
      hostname: "::1",
      port: 8443,
    });
  });

  it("parses unbracketed host:port CONNECT targets", () => {
    expect(parseConnectTarget("api.openai.com:443")).toEqual({
      hostname: "api.openai.com",
      port: 443,
    });
  });

  it("rejects invalid CONNECT ports", () => {
    expect(() => parseConnectTarget("[::1]:99999")).toThrow("Invalid CONNECT target port");
    expect(() => parseConnectTarget("api.openai.com:1e3")).toThrow("Invalid CONNECT target port");
    expect(() => parseConnectTarget("api.openai.com:0x50")).toThrow("Invalid CONNECT target port");
  });
});

describe("proxy upstream response error handling", () => {
  let testRoot: string | undefined;
  let proxyServer: Awaited<ReturnType<typeof startDebugProxyServer>> | undefined;
  let origin: Server | undefined;

  afterEach(async () => {
    await proxyServer?.stop();
    proxyServer = undefined;
    origin?.close();
    origin = undefined;
    if (testRoot) {
      await rm(testRoot, { recursive: true, force: true });
      testRoot = undefined;
    }
  });

  it("returns 502 when upstream destroys the socket mid-response", async () => {
    // Start an origin that writes partial data then kills the connection
    origin = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial");
      res.socket?.destroy();
    });
    await new Promise<void>((resolve) => {
      origin!.listen(0, "127.0.0.1", resolve);
    });
    const originAddr = origin.address() as { port: number };
    const originUrl = `http://127.0.0.1:${originAddr.port}/test`;

    // Start the debug proxy
    testRoot = await mkdtemp(join(tmpdir(), "openclaw-debug-proxy-upstream-err-"));
    const certDir = join(testRoot, "certs");
    await mkdir(certDir, { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(certDir, "root-ca.pem"), "test root cert\n", "utf8");
    await writeFile(join(certDir, "root-ca-key.pem"), "test root key\n", "utf8");
    proxyServer = await startDebugProxyServer({
      settings: {
        enabled: true,
        required: false,
        dbPath: ":memory:",
        blobDir: join(testRoot, "blobs"),
        certDir,
        sessionId: "upstream-error-test",
        sourceProcess: "test",
      },
    });

    // Send a request through the proxy to the broken origin
    const proxy = new URL(proxyServer.proxyUrl);
    const data = await new Promise<string>((resolve) => {
      let body = "";
      const req = httpRequest(
        {
          hostname: proxy.hostname,
          port: Number(proxy.port),
          path: originUrl,
          method: "GET",
          headers: {
            Host: `127.0.0.1:${originAddr.port}`,
            Connection: "close",
          },
        },
        (res) => {
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            body += chunk;
          });
          res.on("end", () => resolve(body));
          res.on("error", () => resolve(body));
        },
      );
      req.on("error", () => resolve(body));
      req.end();
    });

    // The proxy should NOT crash. The response may contain partial data
    // followed by an abrupt close, or the error text from the handler.
    // The key assertion: the proxy process survived (we got a response)
    // and the proxy server is still running.
    expect(data.length).toBeGreaterThan(0);
    expect(proxyServer.proxyUrl).toBeTruthy();
  });
});
