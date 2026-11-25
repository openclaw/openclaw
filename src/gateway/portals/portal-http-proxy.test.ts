import { once } from "node:events";
import {
  createServer,
  request,
  type ClientRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
  type RequestOptions,
} from "node:http";
import net from "node:net";
import { duplexPair, type Duplex } from "node:stream";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { readRequestText } from "../../../test/helpers/gateway-integration-fixtures.js";
import { mockIpv4OnlyLocalhostLookup } from "../../../test/helpers/loopback-dns.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { acquireTestPortBlock } from "../../test-utils/port-claims.js";
import type { PortalTarget } from "./portal-http-proxy.js";
import type { GatewayPortalService } from "./portal-service.js";
import { requestText, usePortalHarness } from "./portal.test-support.js";

type HttpResult = Awaited<ReturnType<typeof requestText>>;

const { target, makeService, listenTarget } = usePortalHarness();
let upgradeRequest: IncomingMessage | undefined;
let targetWebSocketSetCookie: string | undefined;
const targetWss = new WebSocketServer({ server: target.server });

targetWss.on("connection", (socket, req) => {
  upgradeRequest = req;
  socket.on("message", (data) => socket.send(data));
});
targetWss.on("headers", (headers) => {
  if (targetWebSocketSetCookie) {
    headers.push(`Set-Cookie: ${targetWebSocketSetCookie}`);
  }
});

afterEach(() => {
  upgradeRequest = undefined;
  targetWebSocketSetCookie = undefined;
});

afterAll(() => targetWss.close());

function openPortal(options: Partial<Parameters<GatewayPortalService["open"]>[0]> = {}) {
  return makeService().service.open({ targetPort: target.port, ...options });
}

function authenticatedCall(portal: { listenPort: number; tokenQuery: string }, path = "/") {
  return httpCall(portal, path, { headers: { Cookie: portalAuthCookie(portal) } });
}

async function expectEcho(socket: WebSocket, message: string) {
  const echoed = once(socket, "message");
  socket.send(message);
  expect(rawDataToString((await echoed)[0])).toBe(message);
}

function expectWaiting(result: HttpResult, port: number) {
  expect(result.status).toBe(502);
  expect(result.body).toContain(`Waiting for the app on port ${port}…`);
  expect(result.body).toContain('http-equiv="refresh" content="2"');
}

function cookieTarget(value: string, received: Array<string | undefined> = []) {
  return (req: IncomingMessage, res: ServerResponse) => {
    received.push(req.headers.cookie);
    if (req.url === "/set") {
      res.setHeader("Set-Cookie", `session=${value}; Domain=target.example; Path=/; HttpOnly`);
    }
    res.end(`target-${value}`);
  };
}

function createWorkerStreamPair() {
  const [gatewayStream, workerStream] = duplexPair({ allowHalfOpen: false });
  // WebSocket closure delivers EOF to its peer; Node 22's duplexPair does not forward destroy.
  gatewayStream.once("close", () => workerStream.push(null));
  workerStream.once("close", () => gatewayStream.push(null));
  return [gatewayStream, workerStream] as const;
}

function createWorkerStream(port: number): Duplex {
  const [gatewayStream, workerStream] = createWorkerStreamPair();
  const appSocket = net.connect({ host: "127.0.0.1", port });
  workerStream.on("error", () => appSocket.destroy());
  appSocket.on("error", () => workerStream.destroy());
  workerStream.once("close", () => appSocket.destroy());
  appSocket.once("close", () => workerStream.destroy());
  workerStream.pipe(appSocket).pipe(workerStream);
  return gatewayStream;
}

function workerTarget(
  connect = async () => createWorkerStream(target.port),
  remotePort = target.port,
): PortalTarget {
  return { kind: "worker", environmentId: "cloud-worker", ownerEpoch: 3, remotePort, connect };
}

function httpCall(
  portal: { listenPort: number },
  path = "/",
  options: RequestOptions = {},
  body?: string,
) {
  return requestText(`http://127.0.0.1:${portal.listenPort}${path}`, options, body);
}

function storeCookies(jar: Map<string, string>, cookies: readonly string[] | undefined): void {
  for (const cookie of cookies ?? []) {
    const pair = cookie.split(";", 1)[0]!;
    jar.set(pair.slice(0, pair.indexOf("=")), pair);
  }
}

function cookieJarHeader(jar: ReadonlyMap<string, string>): string {
  return [...jar.values()].join("; ");
}

function portalAuthCookie(portal: { listenPort: number; tokenQuery: string }): string {
  const token = portal.tokenQuery.slice("openclaw_portal=".length);
  return `openclaw_portal_${portal.listenPort}=${token}`;
}

const privateHeaders = {
  Cookie: "openclaw_plugin_tab=secret",
  "Tailscale-User-Login": "private@example.test",
  Forwarded: "host=forged.example;proto=https",
  "Cf-Access-Jwt-Assertion": "synthetic-edge-assertion",
  Authorization: "Bearer synthetic-app-token",
  "X-Remove-Me": "remove",
};

function expectSafeHeaders(headers: IncomingMessage["headers"] | undefined, publicUrl: string) {
  expect(headers).toMatchObject({
    "x-forwarded-host": new URL(publicUrl).host,
    "x-forwarded-proto": "http",
    authorization: privateHeaders.Authorization,
  });
  for (const key of "cookie tailscale-user-login forwarded x-remove-me cf-access-jwt-assertion".split(
    " ",
  )) {
    expect(headers?.[key]).toBeUndefined();
  }
}

async function openWebSocket(
  url: string,
  headers?: Record<string, string>,
  finishRequest?: (req: ClientRequest) => void,
): Promise<{ socket: WebSocket; setCookies: string[] | undefined }> {
  let setCookies: string[] | undefined;
  const socket = new WebSocket(url, { headers, finishRequest });
  socket.once("upgrade", (response) => {
    setCookies = response.headers["set-cookie"];
  });
  await once(socket, "open");
  return { socket, setCookies };
}

async function closeWebSocket(socket: WebSocket): Promise<void> {
  const closed = once(socket, "close");
  socket.close();
  await closed;
}

async function browserCall(
  jar: Map<string, string>,
  portal: { listenPort: number },
  path = "/",
): Promise<HttpResult> {
  const cookie = cookieJarHeader(jar);
  const result = await httpCall(portal, path, { headers: cookie ? { Cookie: cookie } : undefined });
  storeCookies(jar, result.headers["set-cookie"]);
  return result;
}

describe("portal HTTP proxy", () => {
  it("proxies a URL token directly, sets a private cookie, and strips the token", async () => {
    const targetPaths: string[] = [];
    target.handler = (req, res) => {
      targetPaths.push(req.url ?? "/");
      res.end("proxied");
    };
    const portal = await openPortal({ targetPort: target.port, title: "App" });

    const unauthorized = await httpCall(portal);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body).toContain("This portal is private");
    expect(unauthorized.body).not.toContain(portal.tokenQuery);
    expect(unauthorized.headers["referrer-policy"]).toBe("no-referrer");

    const authorized = await httpCall(portal, `/preview?x=1&${portal.tokenQuery}`);
    expect(authorized).toMatchObject({ status: 200, body: "proxied" });
    expect(authorized.headers["set-cookie"]?.[0]).toBe(
      `${portalAuthCookie(portal)}; HttpOnly; SameSite=Lax; Path=/`,
    );

    const cookieOnly = await authenticatedCall(portal, "/cookie?y=2");
    expect(cookieOnly).toMatchObject({ status: 200, body: "proxied" });
    expect(targetPaths).toEqual(["/preview?x=1", "/cookie?y=2"]);
  });

  it.for(["unauthorized", "unavailable", "unknown"] as const)(
    "flushes %s upgrades before closing",
    async (failure, { signal }) => {
      const httpServers: Server[] = [];
      const { service } = makeService({
        httpServers,
        ingress: failure === "unknown" ? { domain: "previews.example.net", port: 0 } : undefined,
      });
      const portal = await service.open({
        targetPort: target.port,
        target: workerTarget(async () => {
          throw new Error("Worker unavailable");
        }, target.port),
      });
      const upgraded = createDeferredCore<Duplex>();
      httpServers[0]!.once("upgrade", (_req, socket) => upgraded.resolve(socket));
      const started = Date.now();
      const client = net.connect({
        host: "127.0.0.1",
        port: portal.listenPort,
        allowHalfOpen: true,
      });
      try {
        const chunks: Buffer[] = [];
        client.on("data", (chunk: Buffer) => chunks.push(chunk));
        await once(client, "connect", { signal });
        const ended = once(client, "end", { signal });
        const query = failure === "unavailable" ? `?${portal.tokenQuery}` : "";
        const host = failure === "unknown" ? "missing.previews.example.net" : "localhost";
        client.write(
          `GET /${query} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
        );
        const serverSocket = await upgraded.promise;
        await ended;
        const response = Buffer.concat(chunks).toString("utf8");
        const statusLine = {
          unauthorized: "401 Unauthorized",
          unavailable: "502 Bad Gateway",
          unknown: "404 Not Found",
        }[failure];
        expect(response).toContain(`HTTP/1.1 ${statusLine}`);
        if (failure !== "unavailable") {
          expect(response.split("\r\n\r\n")[1]?.replace(/\r\n$/u, "")).toBe(
            failure === "unknown" ? "Unknown portal" : "Unauthorized",
          );
          expect(Date.now() - started).toBeLessThan(2000);
        }
        expect(serverSocket.destroyed).toBe(true);
        expect(client.writableEnded).toBe(false);
      } finally {
        client.destroy();
      }
    },
  );

  it.each(["local", "worker"])("streams %s HTTP with safe headers", async (kind) => {
    let receivedHeaders: IncomingMessage["headers"] | undefined;
    let receivedBody = "";
    target.handler = (req, res) => {
      receivedHeaders = req.headers;
      res.statusCode = 201;
      res.setHeader("Connection", "keep-alive, x-target-hop");
      res.setHeader("Keep-Alive", "upstream-secret=17");
      res.setHeader("X-Target-Hop", "remove");
      res.setHeader("X-App", "kept");
      res.setHeader("Referrer-Policy", "unsafe-url");
      void readRequestText(req).then(
        (body) => {
          receivedBody = body;
          res.write("hello ");
          res.end("portal");
        },
        (error: unknown) => res.destroy(error instanceof Error ? error : new Error(String(error))),
      );
    };
    const dial = createDeferredCore();
    const release = createDeferredCore();
    const remotePort = 4173;
    const portal = await openPortal(
      kind === "local"
        ? {}
        : {
            targetPort: remotePort,
            target: workerTarget(async () => {
              dial.resolve();
              await release.promise;
              return createWorkerStream(target.port);
            }, remotePort),
          },
    );
    const pending = httpCall(
      portal,
      "/asset?q=1",
      {
        method: "POST",
        headers: {
          ...privateHeaders,
          Host: "portal.example:9999",
          Cookie: `openclaw_plugin_tab=secret; ${portalAuthCookie(portal)}`,
          Connection: "keep-alive, x-remove-me",
          "X-Forwarded-Port": "444",
          "X-Real-IP": "192.0.2.1",
          Referer: `http://127.0.0.1:${portal.listenPort}/?${portal.tokenQuery}`,
        },
      },
      "streamed request",
    );
    if (kind === "worker") {
      await dial.promise;
      release.resolve();
    }
    const result = await pending;

    expect(result).toMatchObject({ status: 201, body: "hello portal" });
    expect(receivedBody).toBe("streamed request");
    expect(result.headers["x-app"]).toBe("kept");
    expect(result.headers["referrer-policy"]).toBe("no-referrer");
    expect(result.headers["x-target-hop"]).toBeUndefined();
    // Node may add its own connection-local Keep-Alive header; the upstream value must not pass.
    expect(result.headers["keep-alive"]).not.toBe("upstream-secret=17");
    expectSafeHeaders(receivedHeaders, portal.publicUrl);
    expect(receivedHeaders).toMatchObject({
      host: `localhost:${kind === "local" ? target.port : remotePort}`,
      "x-forwarded-for": expect.stringMatching(/127\.0\.0\.1|::ffff:127\.0\.0\.1/u),
    });
    for (const key of ["referer", "x-forwarded-port", "x-real-ip"]) {
      expect(receivedHeaders?.[key]).toBeUndefined();
    }
  });

  it("isolates HTTP cookies across A-B-A visits and target-port reuse", async () => {
    const receivedCookiesA: Array<string | undefined> = [];
    target.handler = cookieTarget("a", receivedCookiesA);
    const receivedCookiesB: Array<string | undefined> = [];
    const targetPortB = await listenTarget(cookieTarget("b", receivedCookiesB));
    const { service } = makeService();
    const portalA = await service.open({ targetPort: target.port });
    const portalB = await service.open({ targetPort: targetPortB });
    const jar = new Map<string, string>();

    const initialA = await browserCall(jar, portalA, `/set?${portalA.tokenQuery}`);
    const initialB = await browserCall(jar, portalB, `/set?${portalB.tokenQuery}`);
    expect(initialA).toMatchObject({ status: 200, body: "target-a" });
    expect(initialB).toMatchObject({ status: 200, body: "target-b" });
    expect(
      initialA.headers["set-cookie"]?.find((cookie) => cookie.includes("_session=")),
    ).toContain("HttpOnly");
    for (const result of [initialA, initialB]) {
      expect(result.headers["set-cookie"]?.join("; ")).not.toContain("Domain=");
    }

    for (const [portal, body] of [
      [portalA, "target-a"],
      [portalB, "target-b"],
      [portalA, "target-a"],
    ] as const) {
      expect(await browserCall(jar, portal)).toMatchObject({ status: 200, body });
    }
    expect(receivedCookiesA).toEqual([undefined, "session=a", "session=a"]);
    expect(receivedCookiesB).toEqual([undefined, "session=b"]);
    await service.close(portalA.id);
    const reopened = await service.open({ targetPort: target.port });
    expect(reopened.tokenQuery).not.toBe(portalA.tokenQuery);
    receivedCookiesA.length = 0;
    target.handler = cookieTarget("reopened", receivedCookiesA);
    for (const path of [`/?${reopened.tokenQuery}`, "/set", "/"]) {
      expect(await browserCall(jar, reopened, path)).toMatchObject({
        status: 200,
        body: "target-reopened",
      });
    }
    expect(receivedCookiesA).toEqual([undefined, undefined, "session=reopened"]);
  });

  it("isolates WebSocket cookies across target-port reuse", async () => {
    const { service } = makeService();
    const jar = new Map<string, string>();
    const visit = async (portal: Awaited<ReturnType<typeof openPortal>>, value: string) => {
      targetWebSocketSetCookie = `socket=${value}; Path=/; HttpOnly`;
      const connection = await openWebSocket(
        `ws://127.0.0.1:${portal.listenPort}/hmr?${portal.tokenQuery}`,
        { Cookie: cookieJarHeader(jar) },
      );
      const sent = upgradeRequest?.headers.cookie;
      storeCookies(jar, connection.setCookies);
      await closeWebSocket(connection.socket);
      return sent;
    };
    const first = await service.open({ targetPort: target.port });
    await visit(first, "secret");
    await service.close(first.id);
    const second = await service.open({ targetPort: target.port });
    expect(second.tokenQuery).not.toBe(first.tokenQuery);
    expect([await visit(second, "new"), await visit(second, "new")]).toEqual([
      undefined,
      "socket=new",
    ]);
  });

  it.each(["loopback", "ingress", "/nested/page?q=1", "https://accounts.example.test/login"])(
    "handles %s redirects",
    async (redirect) => {
      const path = "/nested/page?q=1#section";
      const rewritten = redirect === "loopback" || redirect === "ingress";
      const location =
        redirect === "ingress"
          ? `//127.0.0.1:${target.port}${path}`
          : redirect === "loopback"
            ? `http://localhost:${target.port}${path}`
            : redirect;
      target.handler = (_req, res) => {
        res.writeHead(302, { Location: location }).end();
      };
      const { service } = makeService(
        redirect === "ingress" ? { ingress: { domain: "preview.test", port: 0 } } : {},
      );
      const portal = await service.open({ targetPort: target.port });
      const response = await httpCall(portal, `/?${portal.tokenQuery}`, {
        headers: { Host: new URL(portal.publicUrl).host },
      });
      expect(response).toMatchObject({
        status: 302,
        headers: {
          location: rewritten ? new URL(path, portal.publicUrl).href : location,
        },
      });
    },
  );

  it("contains browser socket errors while a worker WebSocket is attaching", async () => {
    target.handler = (_req, res) => res.end("still available");
    const httpServers: Server[] = [];
    const { service } = makeService({ httpServers });
    const dialing = createDeferredCore();
    const attachment = createDeferredCore<Duplex>();
    let firstConnection = true;
    const portal = await service.open({
      targetPort: target.port,
      target: workerTarget(async () => {
        if (!firstConnection) {
          return createWorkerStream(target.port);
        }
        firstConnection = false;
        dialing.resolve();
        return await attachment.promise;
      }, target.port),
    });
    const upgrade = createDeferredCore<Duplex>();
    httpServers[0]!.once("upgrade", (_req, socket) => upgrade.resolve(socket));
    const browser = net.connect({ host: "127.0.0.1", port: portal.listenPort });
    const [lateStream, peer] = createWorkerStreamPair();
    let transport: Duplex | undefined;
    try {
      await once(browser, "connect");
      browser.write(
        `GET /hmr?${portal.tokenQuery} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
      );
      await dialing.promise;
      transport = await upgrade.promise;
      const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
      expect(() => transport!.emit("error", reset)).not.toThrow();
      expect(transport.destroyed).toBe(true);
      const lateClosed = once(lateStream, "close");
      attachment.resolve(lateStream);
      await lateClosed;
      expect(lateStream.destroyed).toBe(true);
      expect(await authenticatedCall(portal)).toMatchObject({
        status: 200,
        body: "still available",
      });
    } finally {
      attachment.resolve(lateStream);
      browser.destroy();
      transport?.destroy();
      lateStream.destroy();
      peer.destroy();
    }
  });

  it.each([
    ["local", "complete", "data: started\n\n"],
    ["worker", "abort", ""],
    ["local", "browser", "data: ready\n\n"],
    ["worker", "app", "data: ready\n\n"],
  ] as const)("streams %s headers before body and settles %s", async (kind, completion, body) => {
    let appResponse: ServerResponse | undefined;
    const appClosed = createDeferredCore();
    target.handler = (_req, res) => {
      appResponse = res;
      res.once("close", appClosed.resolve);
      res.writeHead(200, { "Content-Type": "text/event-stream", "X-App": "header-first" });
      res.flushHeaders();
    };
    const portal = await openPortal({ target: kind === "worker" ? workerTarget() : undefined });
    const connection = { headers: { Cookie: portalAuthCookie(portal) } };
    const browserRequest = request(new URL("/events", portal.url), {
      ...connection,
      signal: AbortSignal.timeout(3_000),
    });
    const responseHeaders = new Promise<IncomingMessage>((resolve, reject) => {
      browserRequest.once("response", resolve);
      browserRequest.once("error", reject);
    });
    browserRequest.end();
    try {
      const browserResponse = await responseHeaders;
      expect(browserResponse).toMatchObject({
        statusCode: 200,
        headers: { "content-type": "text/event-stream", "x-app": "header-first" },
      });
      const chunks: Buffer[] = [];
      const firstChunk = createDeferredCore();
      const responseClosed = new Promise<void>((resolve) => {
        browserResponse.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          firstChunk.resolve();
        });
        browserResponse.on("error", () => undefined);
        browserResponse.once("close", resolve);
      });
      // Produce the body only after the proxy has delivered the upstream headers.
      if (completion === "complete") {
        appResponse!.end("data: started\n\n");
      } else if (completion === "abort") {
        appResponse!.destroy();
      } else {
        appResponse!.write("data: ready\n\n");
      }
      if (completion === "browser" || completion === "app") {
        await firstChunk.promise;
        (completion === "browser" ? browserResponse : appResponse)?.destroy();
      }
      await responseClosed;
      expect(browserResponse.complete).toBe(completion === "complete");
      expect(Buffer.concat(chunks).toString("utf8")).toBe(body);
      await appClosed.promise;
      expect(browserResponse.destroyed).toBe(true);
    } finally {
      browserRequest.destroy();
      appResponse?.destroy();
    }
  });

  it.each(["local", "rejected", "closed", "reset"] as const)(
    "retries %s worker streams",
    async (streamState) => {
      const remotePort = streamState === "local" ? target.port : 4173;
      target.handler = (_req, res) => res.destroy();
      const connect = async (): Promise<Duplex> => {
        if (streamState === "rejected") {
          throw new Error("Worker node stream unavailable");
        }
        const [gatewayStream, workerStream] = createWorkerStreamPair();
        if (streamState === "closed") {
          workerStream.end();
        } else {
          workerStream.destroy();
        }
        return gatewayStream;
      };
      const portal = await openPortal({
        targetPort: remotePort,
        target: streamState === "local" ? undefined : workerTarget(connect, remotePort),
      });
      const cookie = portalAuthCookie(portal);
      const requestHeaders: Record<string, string>[] = [
        { Cookie: cookie },
        ...(streamState === "local"
          ? []
          : [{ Cookie: cookie, Connection: "Upgrade", Upgrade: "websocket" }]),
      ];

      for (const headers of requestHeaders) {
        const result = await httpCall(portal, "/", { headers });
        expectWaiting(result, remotePort);
      }
    },
  );

  it("reaches IPv6-only targets through the localhost dual-stack dial", async () => {
    mockIpv4OnlyLocalhostLookup();
    // Keep IPv4 unclaimed by sibling fixtures while the target binds only ::1.
    const claim = await acquireTestPortBlock({ offsets: [0] });
    const v6Port = claim.port;
    const v6Target = createServer((req, res) => {
      res.end("v6 proxied");
    });
    try {
      await new Promise<void>((resolve, reject) => {
        v6Target.once("error", reject);
        v6Target.listen(v6Port, "::1", () => resolve());
      });
      const portal = await openPortal({ targetPort: v6Port });
      const result = await httpCall(portal, `/?${portal.tokenQuery}`);
      expect(result).toMatchObject({ status: 200, body: "v6 proxied" });
    } finally {
      await new Promise<void>((resolve) => {
        v6Target.close(() => resolve());
      });
      await claim.release();
    }
  });

  it.each(["local", "worker"])("splices and closes %s WebSockets", async (kind) => {
    const { service } = makeService();
    const portal = await service.open({
      targetPort: target.port,
      target: kind === "worker" ? workerTarget() : undefined,
    });
    // A later upgrade needs a new worker stream, not the earlier HTTP connection.
    expect(await authenticatedCall(portal)).toMatchObject({ status: 200, body: "target" });
    targetWebSocketSetCookie = "socket=ready; Domain=target.example; Path=/; HttpOnly";
    const { socket: ws, setCookies: upgradeCookies } = await openWebSocket(
      `ws://127.0.0.1:${portal.listenPort}/hmr?channel=dev`,
      {
        ...privateHeaders,
        Cookie: `${privateHeaders.Cookie}; ${portalAuthCookie(portal)}`,
        "X-Forwarded-Host": "forged.example",
        "X-Forwarded-Proto": "https",
      },
      (req) => {
        // ws installs its own Connection header after user headers.
        req.setHeader("Connection", "Upgrade, x-remove-me");
        req.end();
      },
    );
    await expectEcho(ws, "hot reload");
    expect(upgradeRequest?.url).toBe("/hmr?channel=dev");
    expectSafeHeaders(upgradeRequest?.headers, portal.publicUrl);
    expect(upgradeCookies).toHaveLength(1);
    expect(upgradeCookies?.[0]).toMatch(
      /^oc_portal_[a-f0-9]{32}_socket=ready; Path=\/; HttpOnly$/u,
    );

    const closed = once(ws, "close");
    await service.close(portal.id);
    await closed;
    await expect(httpCall(portal)).rejects.toThrow();
  });
});
