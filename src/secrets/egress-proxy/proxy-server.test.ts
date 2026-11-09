import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import net, { type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { gitNullConfigPath } from "../../infra/git-exec.js";
import { PROXY_ENV_KEYS } from "../../infra/net/proxy-env.js";
import { generateLocalProxyLeaf } from "../../proxy-capture/ca.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { acquireTestPortBlock, type TestPortClaim } from "../../test-utils/port-claims.js";
import {
  mintSecretSentinel,
  resolveSecretSentinel,
  SECRET_SENTINEL_MAX_LENGTH,
  SECRET_SENTINEL_PREFIX,
} from "../sentinel.js";
import {
  startSecretEgressProxyServer,
  type SecretEgressProxyAuditEvent,
  type SecretEgressProxyHandle,
} from "./proxy-server.js";

describe("secret egress proxy", () => {
  type OriginRequest = {
    bytes: Buffer;
    body: string;
    headers: Record<string, string | string[] | undefined>;
    url: string;
  };

  const servers: Server[] = [];
  const portClaims: TestPortClaim[] = [];
  const resolveSentinel = vi.fn(resolveSecretSentinel);
  const proxies: SecretEgressProxyHandle[] = [];
  const sockets = new Set<Duplex>();
  const tempDirs: string[] = [];
  const seedDirs = createTempDirTracker();
  let seed: { dir: string; leaf: Awaited<ReturnType<typeof generateLocalProxyLeaf>> } | undefined;
  let caDir: string;
  let auditEvents: SecretEgressProxyAuditEvent[];
  let originRequests: OriginRequest[];
  let originLeaf: { cert: Buffer; key: Buffer };
  let originPort: number;
  let httpPort: number;
  let proxy: SecretEgressProxyHandle;
  let proxyEnv: Record<string, string>;

  function registerSentinel(
    sentinel: string,
    allowedHosts: readonly string[],
    targetProxy = proxy,
  ) {
    return targetProxy.registerProcess([{ name: "SERVICE_API_KEY", sentinel, allowedHosts }]).env;
  }

  function copyInitialCa(sourceDir: string, targetDir: string): void {
    for (const file of ["root-ca.pem", "root-ca-key.pem", "leaf-key.pem"]) {
      fs.copyFileSync(path.join(sourceDir, file), path.join(targetDir, file));
    }
  }

  async function listen(server: Server, host = "127.0.0.1"): Promise<number> {
    const claim = await acquireTestPortBlock({ offsets: [0] });
    portClaims.push(claim);
    servers.push(server);
    server.listen(claim.port, host);
    await once(server, "listening");
    return claim.port;
  }

  function basicProxyAuth(password: string): string {
    return `Basic ${Buffer.from(`openclaw:${password}`).toString("base64")}`;
  }

  const registeredPassword = (env: Record<string, string>) =>
    new URL(env.HTTPS_PROXY ?? "").password;

  async function readProxyResponse(socket: Socket, headersOnly = false, onContinue?: () => void) {
    let output = "";
    if (!headersOnly) {
      socket.setEncoding("utf8");
    }
    for await (const chunk of socket.iterator({ destroyOnReturn: false })) {
      output += chunk.toString();
      if (output.startsWith("HTTP/1.1 100 Continue\r\n\r\n")) {
        onContinue?.();
      }
      const headEnd = output.indexOf("\r\n\r\n");
      const length = /(?:^|\r\n)content-length:\s*(\d+)/iu.exec(output.slice(0, headEnd));
      if (
        headEnd >= 0 &&
        (headersOnly ||
          (length && Buffer.byteLength(output.slice(headEnd + 4)) >= Number(length[1])))
      ) {
        return output;
      }
    }
    return output;
  }

  async function rawConnect(params: {
    auth?: string;
    proxyOrigin?: string;
    target?: string;
  }): Promise<{ response: string; socket: Socket }> {
    const proxyUrl = new URL(params.proxyOrigin ?? proxy.proxyOrigin);
    const socket = net.connect(Number(proxyUrl.port), proxyUrl.hostname);
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    await once(socket, "connect");
    const target = params.target ?? `localhost:${originPort}`;
    const authLine = params.auth ? `Proxy-Authorization: ${params.auth}\r\n` : "";
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${authLine}\r\n`);
    const response = await readProxyResponse(socket, true);
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

  async function requestThroughProxy(params: {
    mode?: "tls" | "plaintext" | "forward";
    path?: string;
    method?: string;
    headers?: Record<string, string>;
    bodyChunks?: readonly (string | Buffer)[];
    contentLength?: number;
    caPath?: string;
    proxyEnv?: Record<string, string>;
    proxyOrigin?: string;
    auth?: string | null;
  }): Promise<{ body: string; head: string; status: number }> {
    const env = params.proxyEnv ?? proxyEnv;
    const endpoint = new URL(params.proxyOrigin ?? env.HTTPS_PROXY ?? "");
    const mode = params.mode ?? "tls";
    const target = `localhost:${mode === "tls" ? originPort : httpPort}`;
    const auth = params.auth === undefined ? basicProxyAuth(registeredPassword(env)) : params.auth;
    let socket: Socket;
    if (mode === "forward") {
      socket = net.connect(Number(endpoint.port), endpoint.hostname);
      sockets.add(socket);
      await once(socket, "connect");
    } else {
      const connected = await rawConnect({
        auth: auth ?? undefined,
        proxyOrigin: endpoint.origin,
        target,
      });
      expect(connected.response).toContain("200 Connection Established");
      socket = connected.socket;
    }
    if (mode === "tls") {
      const secure = tls.connect({
        socket,
        servername: "localhost",
        ca: fs.readFileSync(params.caPath ?? proxy.caCertPath),
      });
      await once(secure, "secureConnect");
      expect(secure.authorized).toBe(true);
      socket = secure;
    }
    const continued = createDeferredCore();
    const received = readProxyResponse(socket, false, () => continued.resolve());
    const bodyChunks = params.bodyChunks ?? [];
    const headers = {
      Host: target,
      ...(mode === "forward" && auth ? { "Proxy-Authorization": auth } : {}),
      Connection: "close",
      ...(params.contentLength !== undefined
        ? { "Content-Length": String(params.contentLength) }
        : bodyChunks.length > 0
          ? { "Transfer-Encoding": "chunked" }
          : {}),
      ...params.headers,
    };
    socket.write(
      `${params.method ?? "POST"} ${params.path ?? (mode === "forward" ? `http://${target}/` : "/")} HTTP/1.1\r\n`,
    );
    for (const [name, value] of Object.entries(headers)) {
      socket.write(`${name}: ${value}\r\n`);
    }
    socket.write("\r\n");
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
        socket.write(`${Buffer.byteLength(chunk).toString(16)}\r\n`);
      }
      socket.write(chunk);
      if (params.contentLength === undefined) {
        socket.write("\r\n");
      }
    }
    if (bodyChunks.length > 0 && params.contentLength === undefined) {
      socket.write("0\r\n\r\n");
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
    return (
      await requestThroughProxy({
        mode: "forward",
        method: "GET",
        proxyOrigin,
        auth: auth ?? null,
        path: requestTarget ?? `${protocol}://localhost:${originPort}/forwarded-auth`,
      })
    ).status;
  }

  function tamperSentinel(sentinel: string): string {
    const index = SECRET_SENTINEL_PREFIX.length;
    const replacement = sentinel[index] === "A" ? "B" : "A";
    return `${sentinel.slice(0, index)}${replacement}${sentinel.slice(index + 1)}`;
  }

  const recordOrigin: RequestListener = (request, response) => {
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
      if (request.url === "/redirect") {
        response.writeHead(307, {
          Location: `https://127.0.0.1:${originPort}/redirected`,
          Connection: "close",
          "Content-Length": 0,
        });
        response.end();
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
  };

  beforeEach(async () => {
    for (const key of [...PROXY_ENV_KEYS, "NO_PROXY", "no_proxy"]) {
      vi.stubEnv(key, undefined);
    }
    resolveSentinel.mockClear();
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
      resolveSentinel,
    });
    proxies.push(proxy);
    const leaf = seed
      ? { cert: Buffer.from(seed.leaf.cert), key: Buffer.from(seed.leaf.key) }
      : await generateLocalProxyLeaf({
          certDir: caDir,
          ca: { certPath: proxy.caCertPath, keyPath: path.join(caDir, "root-ca-key.pem") },
          hostname: "localhost",
        });
    originLeaf = leaf;
    originPort = await listen(createHttpsServer(leaf, recordOrigin));
    httpPort = await listen(createServer(recordOrigin));
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
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const socket of sockets) {
      socket.destroy();
    }
    sockets.clear();
    for (const currentProxy of proxies.splice(0)) {
      await currentProxy.stop();
    }
    for (const server of servers.splice(0)) {
      server.closeAllConnections?.();
      await promisify(server.close.bind(server))();
    }
    for (const claim of portClaims.splice(0)) {
      await claim.release();
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
  });

  it.each([
    { route: "HTTPS_PROXY", bypass: false },
    { route: "HTTP_PROXY", bypass: false },
    { route: "NO_PROXY", bypass: false },
    { route: "direct", bypass: false },
    { route: "HTTPS_PROXY", bypass: true },
    { route: "NO_PROXY", bypass: true },
    { route: "direct", bypass: true },
  ])("routes HTTPS through $route (bypass=$bypass)", async ({ route, bypass }) => {
    const connects: string[] = [];
    const envProxy = createServer();
    envProxy.on("connect", (request, client, head) => {
      connects.push(request.url ?? "");
      const upstream = net.connect(originPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
      for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      }
      client.once("close", () => upstream.destroy());
      upstream.once("error", () => client.destroy());
    });
    const envProxyPort = await listen(envProxy);
    if (route !== "direct") {
      vi.stubEnv(
        route === "HTTP_PROXY" ? "HTTP_PROXY" : "HTTPS_PROXY",
        `http://127.0.0.1:${envProxyPort}`,
      );
    }
    if (route === "NO_PROXY") {
      vi.stubEnv("NO_PROXY", "localhost,127.0.0.1,::1");
    }
    if (bypass) {
      await proxy.stop();
      proxy = await startSecretEgressProxyServer({
        caDir,
        bypassHosts: ["localhost"],
        onAudit: (event) => auditEvents.push(event),
      });
      proxies.push(proxy);
    }
    const value = "synthetic-proxy-secret";
    const sentinel = mintSecretSentinel(value, { label: "env-proxy" });
    proxyEnv = registerSentinel(sentinel, ["localhost"]);
    expect(
      (await requestThroughProxy({ headers: { Authorization: `Bearer ${sentinel}` } })).status,
    ).toBe(200);
    expect(connects).toEqual(
      route === "HTTPS_PROXY" || route === "HTTP_PROXY" ? [`localhost:${originPort}`] : [],
    );
    expect(originRequests[0]?.headers.authorization).toBe(`Bearer ${bypass ? sentinel : value}`);
    expect(originRequests[0]?.headers["proxy-authorization"]).toBeUndefined();
    if (route === "HTTPS_PROXY" && !bypass) {
      proxyEnv = registerSentinel(sentinel, ["other.example"]);
      expect(
        (await requestThroughProxy({ headers: { Authorization: `Bearer ${sentinel}` } })).status,
      ).toBe(502);
      expect(connects).toHaveLength(1);
      expect(originRequests).toHaveLength(1);
    }
  });

  it("routes loopback HTTP through HTTP_PROXY unless NO_PROXY excludes it", async () => {
    const targets: string[] = [];
    const envProxyPort = await listen(
      createServer((request, response) => {
        targets.push(request.url ?? "");
        response.end("proxied");
      }),
    );
    const directPort = await listen(createServer((_request, response) => response.end("direct")));
    const target = `http://127.0.0.1:${directPort}/loopback`;
    vi.stubEnv("HTTP_PROXY", `http://127.0.0.1:${envProxyPort}`);
    for (const noProxy of ["", "127.0.0.0/8"]) {
      vi.stubEnv("NO_PROXY", noProxy);
      const grant = proxy.registerProcess();
      expect(
        await forwardedRequest(
          basicProxyAuth(registeredPassword(grant.env)),
          "http",
          undefined,
          target,
        ),
      ).toBe(200);
      grant.revoke();
    }
    expect(targets).toEqual([target]);
  });

  it("substitutes multiple sentinels in Basic username and password without decoding other base64", async () => {
    const username = mintSecretSentinel("synthetic-user", { label: "basic-user" });
    const password = mintSecretSentinel("synthetic-password", { label: "basic-password" });
    proxyEnv = proxy.registerProcess([
      { name: "USERNAME", sentinel: username, allowedHosts: ["localhost"] },
      { name: "PASSWORD", sentinel: password, allowedHosts: ["localhost"] },
    ]).env;
    const encoded = Buffer.from(`${username}:${password}`).toString("base64");
    expect(
      (
        await requestThroughProxy({
          headers: {
            Authorization: `Basic ${encoded}`,
            "X-Encoded": encoded,
            "Proxy-Authorization": `Basic ${encoded}`,
          },
          bodyChunks: [encoded],
        })
      ).status,
    ).toBe(200);
    expect(originRequests[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from("synthetic-user:synthetic-password").toString("base64")}`,
    );
    expect(originRequests[0]?.headers["x-encoded"]).toBe(encoded);
    expect(originRequests[0]?.headers["proxy-authorization"]).toBeUndefined();
    expect(originRequests[0]?.body).toBe(encoded);
  });

  it.each([
    "unregistered",
    "tampered",
    "no-colon",
    "control-byte",
    "invalid-utf8",
    "raw-basic",
    "noncanonical",
  ])("refuses %s Basic sentinels before the origin receives credentials", async (kind) => {
    const sentinel = mintSecretSentinel("synthetic-refused-secret", { label: "basic-refusal" });
    const candidate = kind === "tampered" ? tamperSentinel(sentinel) : sentinel;
    if (kind !== "unregistered") {
      proxyEnv = registerSentinel(candidate, ["localhost"]);
    }
    const decoded =
      kind === "no-colon" ? candidate : `user:${candidate}${kind === "control-byte" ? "\n" : ""}`;
    const bytes =
      kind === "invalid-utf8"
        ? Buffer.concat([Buffer.from(decoded), Buffer.from([255])])
        : Buffer.from(decoded);
    const encoded = bytes.toString("base64");
    const credential =
      kind === "raw-basic"
        ? candidate
        : kind === "noncanonical"
          ? encoded.replace(/[=]+$/u, "") + (encoded.endsWith("==") ? "=" : "==")
          : encoded;
    expect(
      (
        await requestThroughProxy({
          headers: { Authorization: `Basic ${credential}` },
        })
      ).status,
    ).toBe(502);
    expect(originRequests).toEqual([]);
    expect(auditEvents.at(-1)?.reason).toBe("unresolved-sentinel");
  });

  it.each(["bAsIc dXNlcjpwYXNz", "Basic malformed!"])(
    "preserves ordinary Basic headers byte-for-byte: %s",
    async (authorization) => {
      expect(
        (await requestThroughProxy({ headers: { Authorization: authorization } })).status,
      ).toBe(200);
      expect(originRequests[0]?.headers.authorization).toBe(authorization);
      expect(auditEvents.at(-1)?.substituted).toBe(false);
    },
  );

  it("returns redirects without following them", async () => {
    const sentinel = mintSecretSentinel("synthetic-redirect-secret", { label: "basic-redirect" });
    proxyEnv = registerSentinel(sentinel, ["localhost"]);
    const headers = {
      Authorization: `Basic ${Buffer.from(`user:${sentinel}`).toString("base64")}`,
    };
    const redirected = await requestThroughProxy({ path: "/redirect", headers });
    expect(redirected.status).toBe(307);
    expect(redirected.head).toContain(`https://127.0.0.1:${originPort}/redirected`);
    expect(originRequests).toHaveLength(1);
  });

  it("forwards a CJK attachment filename from a real upstream and keeps serving", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    try {
      const attachment = await requestThroughProxy({ path: "/cjk-attachment" });
      expect(attachment.status).toBe(200);
      expect(attachment.body).toBe("file");
      expect(attachment.head.toLowerCase()).toContain(
        "content-disposition: attachment; filename=\"___2026-09-21.log\"; filename*=utf-8''%e9%99%84%e4%bb%b6_2026-09-21.log",
      );

      const rejected = await requestThroughProxy({ path: "/invalid-trailer" });
      expect(rejected.status).toBe(502);
      expect(rejected.body).toBe("Secret egress proxy could not forward the upstream response.\n");

      await expect(requestThroughProxy({ path: "/after" })).resolves.toMatchObject({
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
    const result = await requestThroughProxy({
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
      proxyEnv = registerSentinel(
        sentinel,
        kind === "wrong-host" ? ["other.example"] : ["localhost"],
      );
      const body = Buffer.concat([
        Buffer.from([0, 255, 128]),
        Buffer.from(
          kind === "overlong"
            ? SECRET_SENTINEL_PREFIX + "x".repeat(SECRET_SENTINEL_MAX_LENGTH)
            : sentinel,
        ),
      ]);
      const result = await requestThroughProxy({
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
    const result = await requestThroughProxy({
      headers: { "Content-Length": "1", "Transfer-Encoding": "chunked" },
    });
    expect(result.status).toBe(400);
    expect(originRequests).toEqual([]);
  });

  it("refuses malformed targets on direct and TLS requests without escaping the handler", async () => {
    const target = "https://bad_host/";
    const auth = basicProxyAuth(registeredPassword(proxyEnv));
    await expect(forwardedRequest(auth, "https", proxy.proxyOrigin, target)).resolves.toBe(400);
    await expect(requestThroughProxy({ path: target })).resolves.toMatchObject({ status: 400 });
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

  it("survives a refused reset and releases an accepted tunnel ended without bytes", async () => {
    // curl resets refused CONNECT tunnels; wait for the refusal before resetting.
    const refused = await rawConnect({});
    expect(refused.response).toContain("407 Proxy Authentication Required");
    const closed = once(refused.socket, "close");
    refused.socket.resetAndDestroy();
    await closed;

    // The listener must still serve traffic after the reset.
    const getPeer = captureProxySocket();
    const stillAlive = await rawConnect({
      auth: basicProxyAuth(registeredPassword(proxyEnv)),
      target: "127.0.0.1:9",
    });
    expect(stillAlive.response).toContain("200 Connection Established");
    const peer = getPeer();
    const ended = Promise.race([once(peer, "end"), once(peer, "close")]);
    stillAlive.socket.end();
    await ended;
    expect(peer.destroyed).toBe(true);
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

    const result = await requestThroughProxy({
      caPath: restrictedProxy.caCertPath,
      headers: { Authorization: `Bearer ${sentinel}` },
      proxyEnv: registerSentinel(sentinel, ["api.example.com"], restrictedProxy),
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

  it.each(["chunked", "fixed-length"] as const)(
    "substitutes a %s body larger than the maximum carry window",
    async (framing) => {
      const secret = "stream-boundary-🦞-secret";
      const sentinel = mintSecretSentinel(secret, { label: "egress-stream" });
      proxyEnv = registerSentinel(sentinel, ["localhost"]);
      const split = SECRET_SENTINEL_PREFIX.length + 3;
      const prefix = "x".repeat(SECRET_SENTINEL_MAX_LENGTH + 1024);
      const suffix = "y".repeat(2048);

      await expect(
        requestThroughProxy({
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
    await requestThroughProxy({ headers: { "X-Secret": sentinel } });
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

  it("completes CONNECT and verified TLS for a hostname longer than 64 characters", async () => {
    // Object-storage endpoint shape from #152529: <bucket>.<account-id>.<provider-domain>.
    const longHostname = `${"a".repeat(40)}.${"b".repeat(32)}.example.com`;
    expect(longHostname.length).toBeGreaterThan(64);
    const sentinel = mintSecretSentinel("unused-secret-value", { label: "long-hostname" });
    proxyEnv = registerSentinel(sentinel, [longHostname]);

    // The leaf is minted from the CONNECT hostname, so no DNS lookup or request is needed.
    const { response, socket } = await rawConnect({
      auth: basicProxyAuth(registeredPassword(proxyEnv)),
      target: `${longHostname}:${originPort}`,
    });
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
    expect(secureSocket.authorized).toBe(true);
    secureSocket.destroy();
  });

  it.each([
    { host: "[::1]", allowed: true },
    { host: "localhost.example.com", allowed: false },
  ])("permits only literal loopback HTTP to $host", async ({ host, allowed }) => {
    const port = allowed ? await listen(createServer(recordOrigin), "::1") : httpPort;
    const result = await requestThroughProxy({
      mode: "forward",
      path: `http://${host}:${port}/ok`,
    });
    expect(result).toMatchObject({
      status: allowed ? 200 : 502,
      body: allowed ? "ok" : "Secret egress proxy refused the request.\n",
    });
    expect(originRequests.map(({ url }) => url)).toEqual(allowed ? ["/ok"] : []);
    expect(auditEvents).toEqual([
      allowed
        ? { kind: "forwarded", host: "::1", substituted: false }
        : expect.objectContaining({ kind: "refused", reason: "non-https-request" }),
    ]);
  });

  it.each([
    { mode: "forward", location: "body" },
    { mode: "plaintext", location: "body" },
    { mode: "plaintext", location: "header" },
    { mode: "plaintext", location: "WebSocket upgrade" },
    { mode: "tls", location: "unregistered body" },
  ] as const)(
    "refuses $location over $mode before secret resolution",
    async ({ mode, location }) => {
      const refusal = { status: 502, body: "Secret egress proxy refused the request.\n" };
      const original = mintSecretSentinel("synthetic-http-secret", { label: "http-refusal" });
      const sentinel = mode === "tls" ? tamperSentinel(original) : original;
      if (mode !== "tls") {
        proxyEnv = registerSentinel(sentinel, ["localhost"]);
      }
      expect(
        await requestThroughProxy({
          mode,
          method: location === "WebSocket upgrade" ? "GET" : undefined,
          headers:
            location === "WebSocket upgrade"
              ? { Connection: "Upgrade", Upgrade: "websocket", "X-Api-Key": sentinel }
              : location === "header"
                ? { "X-Api-Key": sentinel }
                : undefined,
          bodyChunks:
            location === "body" || mode === "tls" ? [sentinel.slice(0, 8), sentinel.slice(8)] : [],
        }),
      ).toMatchObject(mode === "tls" ? { status: 502 } : refusal);
      expect(originRequests).toEqual([]);
      expect(resolveSentinel).not.toHaveBeenCalled();
      expect(auditEvents).toEqual([
        {
          kind: "refused",
          host: "localhost",
          substituted: false,
          reason: mode === "tls" ? "unresolved-sentinel" : "non-https-request",
        },
      ]);
    },
  );

  async function requestFromNode(source: string, env = proxyEnv): Promise<unknown> {
    const { stdout } = await promisify(execFile)(
      resolveTestNodeExecPath(),
      ["--input-type=module", "-e", source, `http://127.0.0.1:${httpPort}/ok`],
      { env: { SystemRoot: process.env.SystemRoot, ...env } },
    );
    return JSON.parse(stdout);
  }

  it("routes a real Node global fetch child through the injected proxy", async () => {
    expect(
      await requestFromNode(`
      import dc from 'node:diagnostics_channel';
      let proxied = false;
      dc.channel('undici:client:connected').subscribe(({socket}) => { proxied = socket.remotePort === Number(new URL(process.env.HTTP_PROXY).port); });
      const response = await fetch(process.argv[1]);
      console.log(JSON.stringify({status: response.status, body: await response.text(), proxied, node: !process.versions.bun}));
    `),
    ).toEqual({ status: 200, body: "ok", proxied: true, node: true });
    expect(originRequests.map(({ url }) => url)).toEqual(["/ok"]);
  });

  it("refuses a real HTTP child and CONNECT outside the lockdown allowlist", async () => {
    const lockdown = await startSecretEgressProxyServer({
      caDir,
      allowedHosts: [],
      onAudit: (event) => auditEvents.push(event),
    });
    proxies.push(lockdown);
    const { env } = lockdown.registerProcess();
    expect(
      await requestFromNode(
        `
      import {get} from 'node:http';
      get(process.argv[1], response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => body += chunk);
        response.on('end', () => console.log(JSON.stringify({status: response.statusCode, body})));
      }).on('error', error => { console.error(error.message); process.exitCode = 1; });
    `,
        env,
      ),
    ).toEqual({
      status: 403,
      body: 'Host "127.0.0.1" is not in the secret egress proxy traffic allowlist. Add it to secrets.egressProxy.allowedHosts or bind a store secret to it with: openclaw secrets store set <NAME> --allow-host 127.0.0.1, then restart the Gateway.\n',
    });
    const connected = await rawConnect({
      auth: basicProxyAuth(registeredPassword(env)),
      proxyOrigin: lockdown.proxyOrigin,
      target: `127.0.0.1:${httpPort}`,
    });
    expect(connected.response).toContain("403 Forbidden");
    expect(originRequests).toEqual([]);
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents.every((event) => event.reason === "host-not-allowed")).toBe(true);
  });

  it.each([
    ...(["tls", "plaintext"] as const).flatMap((mode) =>
      (["host", "port", "scheme", "network-path"] as const).map((variant) => ({ mode, variant })),
    ),
    { mode: "plaintext", variant: "allowed-https" } as const,
  ])("pins $mode tunnel for $variant targets before substitution", async ({ mode, variant }) => {
    const sentinel = mintSecretSentinel("synthetic-origin-secret", { label: "origin-pinning" });
    proxyEnv = registerSentinel(sentinel, ["localhost", "127.0.0.1"]);
    const port = mode === "tls" ? originPort : httpPort;
    const scheme = mode === "tls" ? "https" : "http";
    const alternatePort =
      variant === "port" || variant === "network-path"
        ? await listen(
            mode === "tls"
              ? createHttpsServer(originLeaf, recordOrigin)
              : createServer(recordOrigin),
          )
        : port;
    const target =
      variant === "allowed-https"
        ? `https://localhost:${originPort}/allowed-https`
        : variant === "host"
          ? `${scheme}://127.0.0.1:${port}/other-host`
          : variant === "scheme"
            ? `${mode === "tls" ? "http" : "https"}://localhost:${port}/other-scheme`
            : variant === "network-path"
              ? `//localhost:${alternatePort}/network-path`
              : `${scheme}://localhost:${alternatePort}/other-port`;
    expect(
      await requestThroughProxy({
        mode,
        path: target,
        headers: { Authorization: `Bearer ${sentinel}` },
      }),
    ).toMatchObject({ status: 400 });
    expect(originRequests).toEqual([]);
    expect(resolveSentinel).not.toHaveBeenCalled();
    expect(auditEvents.every((event) => event.kind === "refused" && !event.substituted)).toBe(true);
  });

  it.each(["tls", "plaintext"] as const)("ignores a forged Host in a %s tunnel", async (mode) => {
    expect(
      await requestThroughProxy({
        mode,
        path: `${mode === "tls" ? "https" : "http"}://localhost:${mode === "tls" ? originPort : httpPort}/pinned`,
        headers: { Host: "other.invalid:9" },
      }),
    ).toMatchObject({ status: 200 });
    expect(originRequests).toHaveLength(1);
    expect(originRequests[0]).toMatchObject({
      url: "/pinned",
      headers: { host: `localhost:${mode === "tls" ? originPort : httpPort}` },
    });
  });

  function captureProxySocket() {
    // Bun delivers connections natively, but both runtimes register socket listeners.
    const listeners = vi.spyOn(net.Socket.prototype, "once");
    return () => {
      const socket = listeners.mock.contexts.find(
        (candidate) =>
          candidate instanceof net.Socket &&
          candidate.localPort === Number(new URL(proxy.proxyOrigin).port),
      );
      if (!(socket instanceof net.Socket)) {
        throw new Error("Proxy did not accept a TCP connection");
      }
      return socket;
    };
  }

  it.each(["idle", "server-speaks-first"])(
    "expires an %s tunnel without forwarding or retaining sniff listeners",
    async (kind) => {
      // Certificate preparation is real I/O; only the idle sniff uses the fake clock.
      await requestThroughProxy({ mode: "plaintext" });
      originRequests.length = 0;
      auditEvents.length = 0;
      let connections = 0;
      const targetPort =
        kind === "idle"
          ? httpPort
          : await listen(
              createServer().on("connection", (socket) => {
                connections += 1;
                socket.end("server-first\n");
              }),
            );
      const getPeer = captureProxySocket();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const connected = await rawConnect({
        auth: basicProxyAuth(registeredPassword(proxyEnv)),
        target: `localhost:${targetPort}`,
      });
      expect(connected.response).toContain("200 Connection Established");
      const peer = getPeer();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(peer.destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(peer.destroyed).toBe(true);
      expect(peer.listenerCount("readable")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(connections).toBe(0);
      expect(originRequests).toEqual([]);
    },
  );

  it.each(["plaintext", "tls"])(
    "closes a grant revoked during %s sniff before handoff",
    async (mode) => {
      let active = true;
      const grant = proxy.registerProcess([], () => active);
      const getPeer = captureProxySocket();
      const connected = await rawConnect({ auth: basicProxyAuth(registeredPassword(grant.env)) });
      expect(connected.response).toContain("200 Connection Established");
      const peer = getPeer();
      const revoked = createDeferredCore();
      // Revoke after the read guard but before the awaited sniff resumes.
      peer.prependOnceListener("readable", () =>
        queueMicrotask(() => {
          active = false;
          revoked.resolve();
        }),
      );
      connected.socket.write(mode === "tls" ? Buffer.from([0x16]) : "G");
      await revoked.promise;
      expect(peer.destroyed).toBe(true);
      expect(originRequests).toEqual([]);
    },
  );
});
