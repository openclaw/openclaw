import { once } from "node:events";
import fs from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import net, { type Socket } from "node:net";
import path from "node:path";
import tls from "node:tls";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { PROXY_ENV_KEYS } from "../../infra/net/proxy-env.js";
import { generateLocalProxyLeaf } from "../../proxy-capture/ca.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { acquireTestPortBlock, type TestPortClaim } from "../../test-utils/port-claims.js";
import { startSecretEgressProxyServer, type SecretEgressProxyHandle } from "./proxy-server.js";

type SecretEgressProxyAuditEvent = Parameters<
  typeof startSecretEgressProxyServer
>[0]["onAudit"] extends (event: infer Event) => void
  ? Event
  : never;

describe("CONNECT source lifecycle controls", () => {
  const dirs = createTempDirTracker();
  const servers: Server[] = [];
  const claims: TestPortClaim[] = [];
  const sockets = new Set<Socket>();
  let proxy: SecretEgressProxyHandle;
  let proxyEnv: Record<string, string>;
  let originPort: number;
  let httpPort: number;
  let originRequests: { url: string; headers: Record<string, string | string[] | undefined> }[];
  let auditEvents: SecretEgressProxyAuditEvent[];
  const basicProxyAuth = (password: string) =>
    "Basic " + Buffer.from("openclaw:" + password).toString("base64");
  const registeredPassword = (env: Record<string, string>) =>
    new URL(env.HTTPS_PROXY ?? "").password;
  async function listen(server: Server): Promise<number> {
    const claim = await acquireTestPortBlock({ offsets: [0] });
    claims.push(claim);
    servers.push(server);
    server.listen(claim.port, "127.0.0.1");
    await once(server, "listening");
    return claim.port;
  }
  beforeEach(async () => {
    for (const key of [...PROXY_ENV_KEYS, "NO_PROXY", "no_proxy"]) {
      vi.stubEnv(key, undefined);
    }
    originRequests = [];
    auditEvents = [];
    const caDir = dirs.make("openclaw-connect-controls-");
    proxy = await startSecretEgressProxyServer({
      caDir,
      onAudit: (event) => auditEvents.push(event),
    });
    const leaf = await generateLocalProxyLeaf({
      certDir: caDir,
      ca: { certPath: proxy.caCertPath, keyPath: path.join(caDir, "root-ca-key.pem") },
      hostname: "localhost",
    });
    const recordOrigin: RequestListener = (request, response) => {
      originRequests.push({ url: request.url ?? "", headers: { ...request.headers } });
      response.writeHead(200, { "Content-Length": 2, Connection: "close" });
      response.end("ok");
    };
    originPort = await listen(createHttpsServer(leaf, recordOrigin));
    httpPort = await listen(createServer(recordOrigin));
    proxyEnv = proxy.registerProcess().env;
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const socket of sockets) {
      socket.destroy();
    }
    sockets.clear();
    await proxy.stop();
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    for (const claim of claims.splice(0)) {
      await claim.release();
    }
    vi.unstubAllEnvs();
  });
  afterAll(() => dirs.cleanup());
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

  async function requestThroughProxy(params: {
    mode: "tls" | "plaintext";
    path?: string;
    headers?: Record<string, string>;
  }) {
    const target = "localhost:" + (params.mode === "tls" ? originPort : httpPort);
    const connected = await rawConnect({
      auth: basicProxyAuth(registeredPassword(proxyEnv)),
      target,
    });
    expect(connected.response).toContain("200 Connection Established");
    let socket = connected.socket;
    if (params.mode === "tls") {
      const secure = tls.connect({
        socket,
        servername: "localhost",
        ca: fs.readFileSync(proxy.caCertPath),
      });
      sockets.add(secure);
      await once(secure, "secureConnect");
      expect(secure.authorized).toBe(true);
      socket = secure;
    }
    const received = readProxyResponse(socket);
    const headers = { Host: target, Connection: "close", ...params.headers };
    socket.write("GET " + (params.path ?? "/") + " HTTP/1.1\r\n");
    for (const [name, value] of Object.entries(headers)) {
      socket.write(name + ": " + value + "\r\n");
    }
    socket.write("\r\n");
    const raw = await received;
    return { status: Number(/^HTTP\/1\.1 (\d{3})/u.exec(raw)?.[1]) };
  }
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
});
