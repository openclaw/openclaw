import { once } from "node:events";
import { Agent, createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { serveControlUiStartupRequest } from "../../../src/gateway/control-ui-availability.ts";
import { classifyControlUiRequest } from "../../../src/gateway/control-ui-routing.ts";
import { createNodeProxyAgent } from "../../../src/infra/net/node-proxy-agent.ts";
import { registerManagedProxyGatewayLoopbackBypass } from "../../../src/infra/net/proxy/proxy-lifecycle.ts";

/** Disposable reverse-proxy example only; never installed or used by the operator Gateway. */
export async function startDisposableGatewayIngress(port: number) {
  const sockets = new Set<Duplex>();
  const track = (socket: Duplex) => {
    if (sockets.has(socket)) {
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const directAgent = new Agent({ keepAlive: false });
  const createUpstream = (req: IncomingMessage) => {
    const targetUrl = "http://127.0.0.1:" + port + (req.url ?? "/");
    // Use the same owner as local Gateway probes; never drop required proxy credentials.
    registerManagedProxyGatewayLoopbackBypass(targetUrl);
    const proxyAgent = createNodeProxyAgent({
      mode: "env",
      targetUrl,
      protocol: "http",
      agentOptions: { keepAlive: false },
    });
    const upstream = request({
      host: "127.0.0.1",
      port,
      path: req.url,
      method: req.method,
      headers: req.headers,
      agent: proxyAgent ?? directAgent,
    });
    upstream.on("socket", track);
    upstream.once("close", () => {
      proxyAgent?.destroy();
    });
    return upstream;
  };

  let requests = 0;
  let upstreamErrors = 0;
  let lastUpstreamStatus: number | undefined;
  const documentRequest = (req: IncomingMessage) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = classifyControlUiRequest({
      basePath: "",
      pathname: url.pathname,
      search: url.search,
      method: req.method,
      accept: req.headers.accept,
    });
    return (
      ["GET", "HEAD"].includes(req.method ?? "") &&
      req.headers.accept?.includes("text/html") === true &&
      (route.kind === "serve" || route.kind === "redirect")
    );
  };
  const respondUnavailable = async (req: IncomingMessage, res: ServerResponse) => {
    if (res.destroyed || res.headersSent) {
      res.destroy();
      return;
    }
    res.setHeader("X-OpenClaw-Proof-Boundary", "disposable-ingress");
    if (
      await serveControlUiStartupRequest(
        req,
        res,
        { ok: false, status: "draining", uptimeMs: 0 },
        new URL(req.url ?? "/", "http://localhost"),
        { controlUiEnabled: true, controlUiBasePath: "", controlUiRoot: { kind: "missing" } },
      )
    ) {
      return;
    }
    res.statusCode = 503;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Retry-After", "1");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("The upstream server is not reachable.");
  };
  const server = createServer((req, res) => {
    requests++;
    const upstream = createUpstream(req);
    upstream.on("response", (response) => {
      lastUpstreamStatus = response.statusCode;
      if (documentRequest(req) && [502, 504].includes(response.statusCode ?? 0)) {
        response.resume();
        void respondUnavailable(req, res).catch((error) => res.destroy(error));
        return;
      }
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.on("error", () => {
      upstreamErrors++;
      void respondUnavailable(req, res).catch((error) => res.destroy(error));
    });
    req.once("aborted", () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on("connection", track);
  server.on("upgrade", (req, socket, head) => {
    track(socket);
    const upstream = createUpstream(req);
    upstream.on("upgrade", (response, peer, peerHead) => {
      track(peer);
      const headers = ["HTTP/1.1 101 Switching Protocols"];
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        headers.push(response.rawHeaders[i] + ": " + response.rawHeaders[i + 1]);
      }
      socket.write(headers.join("\r\n") + "\r\n\r\n");
      if (head.length) {
        peer.write(head);
      }
      if (peerHead.length) {
        socket.write(peerHead);
      }
      peer.pipe(socket).pipe(peer);
      peer.once("error", () => socket.destroy());
      socket.once("error", () => peer.destroy());
    });
    upstream.on("response", (response) => {
      response.resume();
      socket.destroy();
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing disposable ingress port");
  }
  return {
    baseUrl: "http://127.0.0.1:" + address.port + "/",
    diagnostics: () => ({ requests, upstreamErrors, lastUpstreamStatus }),
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      directAgent.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
