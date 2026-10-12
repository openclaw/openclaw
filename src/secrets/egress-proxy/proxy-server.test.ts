import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import net, { type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTempDirTracker,
  useAutoCleanupTempDirTracker,
} from "../../../test/helpers/temp-dir.js";
import { gitNullConfigPath } from "../../infra/git-exec.js";
import { generateLocalProxyLeaf } from "../../proxy-capture/ca.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  mintSecretSentinel,
  SECRET_SENTINEL_MAX_LENGTH,
  SECRET_SENTINEL_PREFIX,
} from "../sentinel.js";
import { startSecretEgressProxyServer, type SecretEgressProxyHandle } from "./proxy-server.js";

type SecretEgressProxyAuditEvent = Parameters<
  typeof startSecretEgressProxyServer
>[0]["onAudit"] extends (event: infer Event) => void
  ? Event
  : never;

describe("secret egress proxy", () => {
  type OriginRequest = {
    bytes: Buffer;
    body: string;
    headers: Record<string, string | string[] | undefined>;
    url: string;
  };

  const servers: Server[] = [];
  const proxies: SecretEgressProxyHandle[] = [];
  const sockets = new Set<Socket>();
  const tempDirs: string[] = [];
  const seedDirs = createTempDirTracker();
  let seed: { dir: string; leaf: Awaited<ReturnType<typeof generateLocalProxyLeaf>> } | undefined;
  let caDir: string;
  let auditEvents: SecretEgressProxyAuditEvent[];
  let originRequests: OriginRequest[];
  let originPort: number;
  let proxy: SecretEgressProxyHandle;
  let proxyEnv: Record<string, string>;

  function registerSentinel(params: {
    sentinel: string;
    allowedHosts: readonly string[];
    name?: string;
    targetProxy?: SecretEgressProxyHandle;
  }): Record<string, string> {
    return (params.targetProxy ?? proxy).registerProcess([
      {
        name: params.name ?? "SERVICE_API_KEY",
        sentinel: params.sentinel,
        allowedHosts: params.allowedHosts,
      },
    ]).env;
  }

  function copyInitialCa(sourceDir: string, targetDir: string): void {
    for (const file of ["root-ca.pem", "root-ca-key.pem", "leaf-key.pem"]) {
      fs.copyFileSync(path.join(sourceDir, file), path.join(targetDir, file));
    }
  }

  async function listen(server: Server): Promise<number> {
    servers.push(server);
    return await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("test server did not bind a TCP port"));
          return;
        }
        resolve(address.port);
      });
    });
  }

  async function closeServer(server: Server): Promise<void> {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  function basicProxyAuth(password: string): string {
    return `Basic ${Buffer.from(`openclaw:${password}`).toString("base64")}`;
  }

  function registeredPassword(env: Record<string, string>): string {
    const proxyUrl = env.HTTPS_PROXY;
    if (!proxyUrl) {
      throw new Error("test proxy environment is missing HTTPS_PROXY");
    }
    return new URL(proxyUrl).password;
  }

  async function rawConnect(params: {
    auth?: string;
    proxyOrigin?: string;
  }): Promise<{ response: string; socket: Socket }> {
    const proxyUrl = new URL(params.proxyOrigin ?? proxy.proxyOrigin);
    const socket = net.connect(Number(proxyUrl.port), proxyUrl.hostname);
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const authLine = params.auth ? `Proxy-Authorization: ${params.auth}\r\n` : "";
    socket.write(
      `CONNECT localhost:${originPort} HTTP/1.1\r\nHost: localhost:${originPort}\r\n${authLine}\r\n`,
    );
    const response = await new Promise<string>((resolve, reject) => {
      let buffered = "";
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString("latin1");
        if (buffered.includes("\r\n\r\n")) {
          socket.off("data", onData);
          resolve(buffered);
        }
      };
      socket.on("data", onData);
      socket.once("error", reject);
      socket.once("close", () => resolve(buffered));
    });
    return { response, socket };
  }

  // Raw upstream bytes: Node's own server cannot emit a Content-Length before a
  // UTF-8 Content-Disposition, which is the order real upstreams commonly send.
  const RAW_UPSTREAM_RESPONSES = new Map<string, Buffer>([
    [
      "/cjk-attachment",
      Buffer.concat([
        Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 4\r\nContent-Disposition: attachment; "),
        Buffer.from('filename="附件_2026-09-21.log"', "utf8"),
        Buffer.from("\r\nConnection: close\r\n\r\nfile"),
      ]),
    ],
    [
      "/invalid-trailer",
      Buffer.from(
        "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nTrailer: Expires\r\nConnection: close\r\n\r\nfile",
      ),
    ],
  ]);

  async function requestThroughTunnel(params: {
    path?: string;
    headers?: Record<string, string>;
    bodyChunks?: readonly (string | Buffer)[];
    contentLength?: number;
    caPath?: string;
    proxyEnv?: Record<string, string>;
  }): Promise<{ body: string; head: string; status: number }> {
    const env = params.proxyEnv ?? proxyEnv;
    const configuredProxy = env.HTTPS_PROXY;
    if (!configuredProxy) {
      throw new Error("test proxy environment is missing HTTPS_PROXY");
    }
    const connected = await rawConnect({
      auth: basicProxyAuth(registeredPassword(env)),
      proxyOrigin: new URL(configuredProxy).origin,
    });
    expect(connected.response).toContain("200 Connection Established");
    const secureSocket = tls.connect({
      socket: connected.socket,
      servername: "localhost",
      ca: fs.readFileSync(params.caPath ?? proxy.caCertPath),
    });
    await new Promise<void>((resolve, reject) => {
      secureSocket.once("secureConnect", resolve);
      secureSocket.once("error", reject);
    });
    expect(secureSocket.authorized).toBe(true);
    const continued = createDeferredCore();
    const received = new Promise<string>((resolve, reject) => {
      let output = "";
      secureSocket.setEncoding("utf8");
      secureSocket.on("data", (chunk) => {
        output += chunk.toString();
        if (output.startsWith("HTTP/1.1 100 Continue\r\n\r\n")) {
          continued.resolve();
        }
      });
      secureSocket.once("end", () => resolve(output));
      secureSocket.once("error", reject);
    });
    const bodyChunks = params.bodyChunks ?? [];
    const headers = {
      Host: `localhost:${originPort}`,
      Connection: "close",
      ...(params.contentLength !== undefined
        ? { "Content-Length": String(params.contentLength) }
        : bodyChunks.length > 0
          ? { "Transfer-Encoding": "chunked" }
          : {}),
      ...params.headers,
    };
    secureSocket.write(`POST ${params.path ?? "/"} HTTP/1.1\r\n`);
    for (const [name, value] of Object.entries(headers)) {
      secureSocket.write(`${name}: ${value}\r\n`);
    }
    secureSocket.write("\r\n");
    if (params.headers?.Expect === "100-continue") {
      await Promise.race([
        continued.promise,
        received.then(() => {
          throw new Error("Proxy did not acknowledge 100-continue");
        }),
      ]);
    }
    for (const chunk of bodyChunks) {
      if (params.contentLength === undefined) {
        secureSocket.write(`${Buffer.byteLength(chunk).toString(16)}\r\n`);
      }
      secureSocket.write(chunk);
      if (params.contentLength === undefined) {
        secureSocket.write("\r\n");
      }
    }
    if (bodyChunks.length > 0 && params.contentLength === undefined) {
      secureSocket.write("0\r\n\r\n");
    }
    const raw = (await received).replace(/^(?:HTTP\/1\.1 100 Continue\r\n\r\n)+/u, "");
    const [head = "", body = ""] = raw.split("\r\n\r\n", 2);
    const status = Number(/^HTTP\/1\.1 (\d{3})/u.exec(head)?.[1]);
    return { body, head, status };
  }

  async function forwardedRequest(
    auth?: string,
    protocol = "https",
    proxyOrigin = proxy.proxyOrigin,
    requestTarget?: string,
  ): Promise<number> {
    const proxyUrl = new URL(proxyOrigin);
    return await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: proxyUrl.hostname,
          port: proxyUrl.port,
          path: requestTarget ?? `${protocol}://localhost:${originPort}/forwarded-auth`,
          method: "GET",
          // Exercise this fixture directly even when Node enables environment proxies.
          agent: false,
          headers: auth ? { "Proxy-Authorization": auth } : undefined,
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode ?? 0));
        },
      );
      request.once("error", reject);
      request.end();
    });
  }

  function tamperSentinel(sentinel: string): string {
    const index = SECRET_SENTINEL_PREFIX.length;
    const replacement = sentinel[index] === "A" ? "B" : "A";
    return `${sentinel.slice(0, index)}${replacement}${sentinel.slice(index + 1)}`;
  }

  beforeEach(async () => {
    auditEvents = [];
    originRequests = [];
    caDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-egress-proxy-test-"));
    tempDirs.push(caDir);
    if (seed) {
      copyInitialCa(seed.dir, caDir);
    }
    proxy = await startSecretEgressProxyServer({
      caDir,
      onAudit: (event) => auditEvents.push(event),
    });
    proxies.push(proxy);
    const leaf = seed
      ? { cert: Buffer.from(seed.leaf.cert), key: Buffer.from(seed.leaf.key) }
      : await generateLocalProxyLeaf({
          certDir: caDir,
          ca: { certPath: proxy.caCertPath, keyPath: path.join(caDir, "root-ca-key.pem") },
          hostname: "localhost",
        });
    originPort = await listen(
      createHttpsServer(leaf, (request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        request.on("end", () => {
          const bytes = Buffer.concat(chunks);
          originRequests.push({
            bytes,
            body: bytes.toString("utf8"),
            headers: { ...request.headers },
            url: request.url ?? "",
          });
          const rawResponse = RAW_UPSTREAM_RESPONSES.get(request.url ?? "");
          if (rawResponse) {
            request.socket.end(rawResponse);
            return;
          }
          if (request.url?.startsWith("/git/")) {
            response.writeHead(200, { "Content-Type": "text/plain", Connection: "close" });
            response.end(
              request.url === "/git/HEAD"
                ? "ref: refs/heads/main\n"
                : `${"a".repeat(40)}\trefs/heads/main\n`,
            );
            return;
          }
          const status =
            request.url === "/fixed-length" && request.headers["content-length"] === undefined
              ? 411
              : 200;
          response.writeHead(status, { Connection: "close", "Content-Length": 2 });
          response.end("ok");
        });
      }),
    );
    proxyEnv = proxy.registerProcess().env;
    if (!seed) {
      // Capture after cold setup succeeds, before a case can mutate its files.
      const dir = seedDirs.make("openclaw-egress-proxy-seed-");
      try {
        copyInitialCa(caDir, dir);
        seed = { dir, leaf: { cert: Buffer.from(leaf.cert), key: Buffer.from(leaf.key) } };
      } catch (error) {
        seedDirs.cleanup();
        throw error;
      }
    }
  });

  afterAll(() => seedDirs.cleanup());

  afterEach(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    sockets.clear();
    for (const currentProxy of proxies.splice(0)) {
      await currentProxy.stop();
    }
    for (const server of servers.splice(0)) {
      await closeServer(server);
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forwards a CJK attachment filename from a real upstream and keeps serving", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    try {
      const attachment = await requestThroughTunnel({ path: "/cjk-attachment" });
      expect(attachment.status).toBe(200);
      expect(attachment.body).toBe("file");
      expect(attachment.head.toLowerCase()).toContain(
        "content-disposition: attachment; filename=\"___2026-09-21.log\"; filename*=utf-8''%e9%99%84%e4%bb%b6_2026-09-21.log",
      );

      const rejected = await requestThroughTunnel({ path: "/invalid-trailer" });
      expect(rejected.status).toBe(502);
      expect(rejected.body).toBe("Secret egress proxy could not forward the upstream response.\n");

      await expect(requestThroughTunnel({ path: "/after" })).resolves.toMatchObject({
        body: "ok",
        status: 200,
      });
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("preserves fixed-length binary upload bytes and framing", async () => {
    const bytes = Buffer.from(Array.from({ length: 8192 }, (_, index) => index % 256));
    const result = await requestThroughTunnel({
      path: "/fixed-length",
      headers: { "Content-Type": "application/octet-stream" },
      contentLength: bytes.length,
      bodyChunks: [bytes.subarray(0, 11), bytes.subarray(11)],
    });
    expect(originRequests).toHaveLength(1);
    expect(originRequests[0]?.bytes).toEqual(bytes);
    expect(result.status).toBe(200);
    expect(originRequests[0]?.headers["content-length"]).toBe(String(bytes.length));
    expect(originRequests[0]?.headers["transfer-encoding"]).toBeUndefined();
  });

  it.each(["overlong", "wrong-host"] as const)(
    "refuses %s sentinels inside fixed-length binary content",
    async (kind) => {
      const sentinel = mintSecretSentinel("synthetic-body-credential", { label: kind });
      proxyEnv = registerSentinel({
        sentinel,
        allowedHosts: kind === "wrong-host" ? ["other.example"] : ["localhost"],
      });
      const body = Buffer.concat([
        Buffer.from([0, 255, 128]),
        Buffer.from(
          kind === "overlong"
            ? SECRET_SENTINEL_PREFIX + "x".repeat(SECRET_SENTINEL_MAX_LENGTH)
            : sentinel,
        ),
      ]);
      const result = await requestThroughTunnel({
        headers: { "Content-Type": "application/octet-stream" },
        contentLength: body.length,
        bodyChunks: [body],
      });
      expect(result.status).toBe(502);
      expect(originRequests).toEqual([]);
      expect(auditEvents.at(-1)).toMatchObject({
        kind: "refused",
        reason: kind === "wrong-host" ? "destination-not-allowed" : "unresolved-sentinel",
      });
    },
  );

  it("rejects conflicting content-length and chunked request framing", async () => {
    const result = await requestThroughTunnel({
      headers: { "Content-Length": "1", "Transfer-Encoding": "chunked" },
    });
    expect(result.status).toBe(400);
    expect(originRequests).toEqual([]);
  });

  it("refuses malformed targets on direct and TLS requests without escaping the handler", async () => {
    const target = "https://bad_host/";
    const auth = basicProxyAuth(registeredPassword(proxyEnv));
    await expect(forwardedRequest(auth, "https", proxy.proxyOrigin, target)).resolves.toBe(400);
    await expect(requestThroughTunnel({ path: target })).resolves.toMatchObject({ status: 400 });
    expect(originRequests).toEqual([]);
    expect(auditEvents).toEqual([
      expect.objectContaining({ kind: "refused", substituted: false }),
      expect.objectContaining({ kind: "refused", substituted: false }),
    ]);
    await expect(forwardedRequest(auth)).resolves.toBe(200);
    expect(originRequests).toHaveLength(1);
  });

  it("lets Git HTTPS discovery trust the registered proxy certificate", async () => {
    expect(fs.statSync(caDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(caDir, "root-ca-key.pem")).mode & 0o777).toBe(0o600);
    const result = await promisify(execFile)(
      "git",
      ["ls-remote", `https://localhost:${originPort}/git`, "refs/heads/main"],
      {
        cwd: caDir,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: caDir,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: gitNullConfigPath(),
          GIT_TERMINAL_PROMPT: "0",
          ...proxyEnv,
        },
        timeout: 10_000,
      },
    );
    expect(result.stdout).toBe(`${"a".repeat(40)}\trefs/heads/main\n`);
    expect(originRequests.some((request) => request.url.startsWith("/git/info/refs"))).toBe(true);
    expect(auditEvents).toContainEqual(expect.objectContaining({ kind: "forwarded" }));
  });

  it("survives a client that resets a refused tunnel instead of crashing the Gateway", async () => {
    // curl resets refused CONNECT tunnels; wait for the refusal before resetting.
    const refused = await rawConnect({});
    expect(refused.response).toContain("407 Proxy Authentication Required");
    const closed = new Promise<void>((resolve) => {
      refused.socket.once("close", () => resolve());
    });
    refused.socket.resetAndDestroy();
    await closed;

    // The listener must still serve traffic after the reset.
    const stillAlive = await rawConnect({ auth: basicProxyAuth(registeredPassword(proxyEnv)) });
    expect(stillAlive.response).toContain("200 Connection Established");
    stillAlive.socket.destroy();
  });

  it.each([
    { label: "missing", auth: undefined, expectedReason: "missing-proxy-auth" },
    {
      label: "malformed",
      auth: basicProxyAuth("wrong-token"),
      expectedReason: "invalid-proxy-auth",
    },
  ])("refuses $label authentication on CONNECT and forwarded requests", async (testCase) => {
    const connect = await rawConnect({ auth: testCase.auth });
    expect(connect.response).toContain("407 Proxy Authentication Required");
    connect.socket.destroy();

    await expect(forwardedRequest(testCase.auth)).resolves.toBe(407);
    expect(originRequests).toEqual([]);
    expect(auditEvents).toEqual([
      expect.objectContaining({ kind: "refused", reason: testCase.expectedReason }),
      expect.objectContaining({ kind: "refused", reason: testCase.expectedReason }),
    ]);
  });

  it("keeps per-secret destination bindings narrower than the traffic allowlist", async () => {
    const restrictedEvents: SecretEgressProxyAuditEvent[] = [];
    const restrictedProxy = await startSecretEgressProxyServer({
      caDir,
      allowedHosts: ["localhost"],
      onAudit: (event) => restrictedEvents.push(event),
    });
    proxies.push(restrictedProxy);
    const secret = "wrong-destination-secret";
    const sentinel = mintSecretSentinel(secret, { label: "egress-wrong-destination" });

    const result = await requestThroughTunnel({
      caPath: restrictedProxy.caCertPath,
      headers: { Authorization: `Bearer ${sentinel}` },
      proxyEnv: registerSentinel({
        sentinel,
        allowedHosts: ["api.example.com"],
        targetProxy: restrictedProxy,
      }),
    });

    expect(result.status).toBe(502);
    expect(result.body).toContain("--allow-host localhost");
    expect(originRequests).toEqual([]);
    expect(restrictedEvents.at(-1)).toMatchObject({
      kind: "refused",
      host: "localhost",
      reason: "destination-not-allowed",
    });
  });

  it("refuses an unresolved sentinel in a streamed body", async () => {
    const unknown = tamperSentinel(mintSecretSentinel("unknown-body", { label: "egress-body" }));
    const before = originRequests.length;
    const result = await requestThroughTunnel({
      path: "/refuse",
      bodyChunks: [unknown],
    });

    expect(result.status).toBe(502);
    expect(originRequests).toHaveLength(before);
    expect(auditEvents.at(-1)).toMatchObject({
      kind: "refused",
      reason: "unresolved-sentinel",
    });
  });

  it.each(["chunked", "fixed-length"] as const)(
    "substitutes a %s body larger than the maximum carry window",
    async (framing) => {
      const secret = "stream-boundary-🦞-secret";
      const sentinel = mintSecretSentinel(secret, { label: "egress-stream" });
      proxyEnv = registerSentinel({ sentinel, allowedHosts: ["localhost"] });
      const split = SECRET_SENTINEL_PREFIX.length + 3;
      const prefix = "x".repeat(SECRET_SENTINEL_MAX_LENGTH + 1024);
      const suffix = "y".repeat(2048);

      await expect(
        requestThroughTunnel({
          path: framing === "fixed-length" ? "/fixed-length" : "/",
          headers:
            framing === "fixed-length"
              ? { Expect: "100-continue", Trailer: "X-Checksum" }
              : undefined,
          contentLength:
            framing === "fixed-length" ? Buffer.byteLength(prefix + sentinel + suffix) : undefined,
          bodyChunks: [prefix, sentinel.slice(0, split), sentinel.slice(split), suffix],
        }),
      ).resolves.toMatchObject({ status: 200 });

      expect(originRequests.at(-1)?.body).toBe(`${prefix}${secret}${suffix}`);
      expect(originRequests.at(-1)?.body).not.toContain(sentinel);
      expect(originRequests.at(-1)?.headers.expect).toBeUndefined();
      expect(originRequests.at(-1)?.headers.trailer).toBeUndefined();
      expect(originRequests.at(-1)?.headers["content-length"]).toBe(
        framing === "fixed-length"
          ? String(Buffer.byteLength(prefix + secret + suffix))
          : undefined,
      );
      expect(originRequests.at(-1)?.headers["transfer-encoding"]).toBe(
        framing === "chunked" ? "chunked" : undefined,
      );
    },
  );

  it("revokes only the owning process's Basic authorization and keeps audits payload-free", async () => {
    const secret = "audit-secret-value";
    const sentinel = mintSecretSentinel(secret, { label: "egress-audit" });
    const grant = proxy.registerProcess([
      { name: "SERVICE_API_KEY", sentinel, allowedHosts: ["localhost"] },
    ]);
    proxyEnv = grant.env;
    const sibling = proxy.registerProcess();
    await requestThroughTunnel({ headers: { "X-Secret": sentinel } });
    await expect(
      forwardedRequest(
        basicProxyAuth(registeredPassword(proxyEnv)),
        "http",
        proxy.proxyOrigin,
        "http://example.com/",
      ),
    ).resolves.toBe(502);
    expect(auditEvents).toContainEqual(
      expect.objectContaining({ kind: "refused", reason: "non-https-request" }),
    );

    grant.revoke();
    const refused = await rawConnect({
      auth: basicProxyAuth(registeredPassword(proxyEnv)),
    });
    expect(refused.response).toContain("407 Proxy Authentication Required");
    refused.socket.destroy();
    await expect(forwardedRequest(basicProxyAuth(registeredPassword(proxyEnv)))).resolves.toBe(407);
    await expect(forwardedRequest(basicProxyAuth(registeredPassword(sibling.env)))).resolves.toBe(
      200,
    );

    const auditText = JSON.stringify(auditEvents);
    expect(auditText).not.toContain(secret);
    expect(auditText).not.toContain(sentinel);
  });

  it("completes the CONNECT tunnel and TLS handshake for a hostname longer than 64 characters", async () => {
    // Mirrors the object-storage endpoint shape from #152529: <bucket>.<account-id>.<provider-domain>.
    const longHostname = `${"a".repeat(40)}.${"b".repeat(32)}.example.com`;
    expect(longHostname.length).toBeGreaterThan(64);
    const sentinel = mintSecretSentinel("unused-secret-value", { label: "long-hostname" });
    proxyEnv = registerSentinel({ sentinel, allowedHosts: [longHostname] });

    // rawConnect() always issues "CONNECT localhost:<port>"; open the tunnel by hand here
    // instead, since the client only needs to reach this process's own proxy socket. The
    // leaf certificate is minted on demand from the hostname in the CONNECT line, so no DNS
    // resolution of longHostname, and no request past the TLS handshake, is needed here.
    const socket = net.connect(Number(new URL(proxy.proxyOrigin).port), "127.0.0.1");
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(
      `CONNECT ${longHostname}:${originPort} HTTP/1.1\r\nHost: ${longHostname}:${originPort}\r\nProxy-Authorization: ${basicProxyAuth(registeredPassword(proxyEnv))}\r\n\r\n`,
    );
    const response = await new Promise<string>((resolve, reject) => {
      let buffered = "";
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString("latin1");
        if (buffered.includes("\r\n\r\n")) {
          socket.off("data", onData);
          resolve(buffered);
        }
      };
      socket.on("data", onData);
      socket.once("error", reject);
      socket.once("close", () => resolve(buffered));
    });
    // Against unmodified code, leaf generation throws inside tlsServerFor() because the CSR's
    // CommonName exceeds the X.509 64-byte cap for this hostname, and the CONNECT never
    // completes; this assertion is what turns that into a visible test failure.
    expect(response).toContain("200 Connection Established");

    const secureSocket = tls.connect({
      socket,
      servername: longHostname,
      ca: fs.readFileSync(proxy.caCertPath),
    });
    await new Promise<void>((resolve, reject) => {
      secureSocket.once("secureConnect", resolve);
      secureSocket.once("error", reject);
    });
    // Verifies the exact production check (X509Certificate#checkHost against the real,
    // openssl-minted, CA-chained leaf) that a real HTTPS client performs for this hostname.
    expect(secureSocket.authorized).toBe(true);
    secureSocket.destroy();
  });
});

describe("secret egress plain HTTP", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterAll);
  const servers: Server[] = [];
  const audit: SecretEgressProxyAuditEvent[] = [];
  const observed: Array<{ url: string | undefined; body: string; port: number | undefined }> = [];
  let proxy: SecretEgressProxyHandle;
  let port: number;
  let ipv6Port: number;

  async function listen(host: string): Promise<number> {
    const server = createServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        observed.push({
          url: incoming.url,
          body: Buffer.concat(chunks).toString(),
          port: incoming.socket.remotePort,
        });
        response.end("loopback-ok");
      });
    });
    servers.push(server);
    server.listen(0, host);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("HTTP fixture did not bind a TCP port");
    }
    return address.port;
  }

  beforeAll(async () => {
    const caDir = tempDirs.make("openclaw-egress-http-");
    proxy = await startSecretEgressProxyServer({ caDir, onAudit: (event) => audit.push(event) });
    port = await listen("127.0.0.1");
    ipv6Port = await listen("::1");
  });

  beforeEach(() => {
    audit.length = 0;
    observed.length = 0;
  });

  afterAll(async () => {
    await proxy.stop();
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  async function request(
    params: {
      target?: string;
      env?: Record<string, string>;
      chunks?: string[];
    } = {},
  ): Promise<{ status: number; body: string }> {
    const env = params.env ?? proxy.registerProcess().env;
    const endpoint = new URL(env.HTTP_PROXY!);
    return await new Promise((resolve, reject) => {
      const outgoing = httpRequest(
        {
          hostname: endpoint.hostname,
          port: endpoint.port,
          path: params.target ?? `http://localhost:${port}/ok`,
          method: params.chunks ? "POST" : "GET",
          agent: false,
          headers: {
            "Proxy-Authorization": `Basic ${Buffer.from(`openclaw:${endpoint.password}`).toString("base64")}`,
          },
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.once("error", reject);
          response.once("end", () => resolve({ status: response.statusCode ?? 0, body }));
        },
      );
      outgoing.once("error", reject);
      for (const chunk of params.chunks ?? []) {
        outgoing.write(chunk);
      }
      outgoing.end();
    });
  }

  // Node's HTTP client honors NODE_USE_ENV_PROXY and uses absolute-form HTTP forwarding.
  // fetch's CONNECT transport exercises a different proxy entry point.
  const CHILD_REQUEST = `
  const http = require('node:http');
  let port;
  const request = http.get(process.argv[1], response => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', chunk => body += chunk);
    response.on('end', () => console.log(JSON.stringify({ status: response.statusCode, body, port })));
  });
  request.on('socket', socket => socket.on('connect', () => { port = socket.localPort; }));
  request.on('error', error => { console.error(error.message); process.exitCode = 1; });
`;

  it.each([
    { host: "[::1]", allowed: true },
    { host: "localhost.example.com", allowed: false },
  ])("permits only literal loopback HTTP to $host", async ({ host, allowed: permitted }) => {
    expect(
      await request({ target: `http://${host}:${host === "[::1]" ? ipv6Port : port}/ok` }),
    ).toEqual(
      permitted
        ? { status: 200, body: "loopback-ok" }
        : { status: 502, body: "Secret egress proxy refused the request.\n" },
    );
    if (permitted) {
      expect(observed).toHaveLength(1);
      expect(observed[0]?.url).toBe("/ok");
      expect(audit).toEqual([
        { kind: "forwarded", host: host === "[::1]" ? "::1" : host, substituted: false },
      ]);
    } else {
      expect(observed).toEqual([]);
      expect(audit).toEqual([
        expect.objectContaining({ kind: "refused", reason: "non-https-request" }),
      ]);
    }
  });

  it("refuses a loopback HTTP sentinel split across body chunks", async () => {
    const sentinel = mintSecretSentinel("synthetic-http-secret", { label: "http-refusal" });
    const grant = proxy.registerProcess([
      { name: "SERVICE_API_KEY", sentinel, allowedHosts: ["localhost"] },
    ]);
    try {
      expect(
        await request({
          env: grant.env,
          chunks: [sentinel.slice(0, 8), sentinel.slice(8)],
        }),
      ).toEqual({ status: 502, body: "Secret egress proxy refused the request.\n" });
      expect(observed).toEqual([]);
      expect(audit).toEqual([
        { kind: "refused", host: "localhost", substituted: false, reason: "non-https-request" },
      ]);
    } finally {
      grant.revoke();
    }
  });

  it("refuses a real HTTP child outside the lockdown allowlist", async () => {
    const lockdown = await startSecretEgressProxyServer({
      caDir: tempDirs.make("openclaw-egress-http-lockdown-"),
      allowedHosts: [],
      onAudit: (event) => audit.push(event),
    });
    const grant = lockdown.registerProcess();
    try {
      const result = await promisify(execFile)(
        process.execPath,
        ["-e", CHILD_REQUEST, `http://127.0.0.1:${port}/ok`],
        { env: { SystemRoot: process.env.SystemRoot, ...grant.env } },
      );
      const response = JSON.parse(result.stdout);
      expect(response.status).toBe(403);
      expect(response.body).toBe(
        'Host "127.0.0.1" is not in the secret egress proxy traffic allowlist. Add it to secrets.egressProxy.allowedHosts or bind a store secret to it with: openclaw secrets store set <NAME> --allow-host 127.0.0.1, then restart the Gateway.\n',
      );
      expect(observed).toEqual([]);
      expect(audit).toEqual([
        { kind: "refused", host: "127.0.0.1", substituted: false, reason: "host-not-allowed" },
      ]);
    } finally {
      grant.revoke();
      await lockdown.stop();
    }
  });

  it("routes a real child through the proxy", async () => {
    const grant = proxy.registerProcess();
    try {
      const result = await promisify(execFile)(
        process.execPath,
        ["-e", CHILD_REQUEST, `http://127.0.0.1:${port}/ok`],
        {
          env: { SystemRoot: process.env.SystemRoot, ...grant.env },
        },
      );
      const response = JSON.parse(result.stdout);
      expect(response.status).toBe(200);
      expect(response.body).toBe("loopback-ok");
      expect(observed).toHaveLength(1);
      expect(observed[0]?.port).toBeTypeOf("number");
      expect(response.port).toBeTypeOf("number");
      expect(audit).toEqual([{ kind: "forwarded", host: "127.0.0.1", substituted: false }]);
    } finally {
      grant.revoke();
    }
  });
});
