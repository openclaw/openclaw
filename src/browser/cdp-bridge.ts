import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { withNoProxyForCdpUrl } from "./cdp-proxy-bypass.js";
import { getHeadersWithAuth, openCdpWebSocket } from "./cdp.helpers.js";

export type LocalCdpBridgeServer = {
  bindHost: string;
  port: number;
  baseUrl: string;
  upstreamUrl: string;
  stop: () => Promise<void>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type UrlRewriteMapping = {
  upstreamBase: URL;
  localBase: URL;
};

function isWebSocketProtocol(protocol: string): boolean {
  return protocol === "ws:" || protocol === "wss:";
}

function normalizeBasePath(pathname: string): string {
  const normalized = pathname.replace(/\/$/, "");
  return normalized === "" ? "/" : normalized;
}

function joinPaths(basePath: string, suffixPath: string): string {
  const normalizedBase = normalizeBasePath(basePath);
  const normalizedSuffix = suffixPath.startsWith("/") ? suffixPath : `/${suffixPath}`;
  if (normalizedBase === "/") {
    return normalizedSuffix;
  }
  return `${normalizedBase}${normalizedSuffix}`;
}

function filterHopByHopHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const filtered: Record<string, string> = {};
  const hopByHop = new Set([
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);
  for (const [key, value] of Object.entries(headers)) {
    if (hopByHop.has(key.toLowerCase()) || value === undefined) {
      continue;
    }
    filtered[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return filtered;
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return undefined;
  }
  return Buffer.concat(chunks);
}

function buildUpstreamHttpUrl(upstreamBase: URL, reqUrl: string): string {
  if (isWebSocketProtocol(upstreamBase.protocol)) {
    throw new Error("HTTP forwarding is unavailable for WebSocket-only CDP bridge upstreams");
  }
  const incoming = new URL(reqUrl, "http://127.0.0.1");
  const target = new URL(upstreamBase.toString());
  target.pathname = joinPaths(upstreamBase.pathname, incoming.pathname);
  target.search = incoming.search;
  return target.toString();
}

function buildUpstreamWsUrl(upstreamBase: URL, reqUrl: string): string {
  const incoming = new URL(reqUrl, "http://127.0.0.1");
  const target = new URL(upstreamBase.toString());
  if (isWebSocketProtocol(upstreamBase.protocol)) {
    const shouldUseUpstreamPath = incoming.pathname === "/" || incoming.pathname === "";
    target.pathname = shouldUseUpstreamPath ? upstreamBase.pathname : incoming.pathname;
    target.search =
      shouldUseUpstreamPath && incoming.search === "" ? upstreamBase.search : incoming.search;
    return target.toString();
  }
  target.protocol = upstreamBase.protocol === "https:" ? "wss:" : "ws:";
  target.pathname = joinPaths(upstreamBase.pathname, incoming.pathname);
  target.search = incoming.search;
  return target.toString();
}

function rewriteUrl(raw: string, mapping: UrlRewriteMapping): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }

  const sameHost = parsed.host === mapping.upstreamBase.host;
  const sameTransportFamily =
    isWebSocketProtocol(parsed.protocol) === isWebSocketProtocol(mapping.upstreamBase.protocol);
  if (!sameHost || !sameTransportFamily) {
    return raw;
  }

  const upstreamBasePath = normalizeBasePath(mapping.upstreamBase.pathname);
  const normalizedPath = normalizeBasePath(parsed.pathname);
  const matchesBase =
    upstreamBasePath === "/" ||
    normalizedPath === upstreamBasePath ||
    normalizedPath.startsWith(`${upstreamBasePath}/`);
  if (!matchesBase) {
    return raw;
  }

  const relativePath =
    upstreamBasePath === "/"
      ? parsed.pathname
      : parsed.pathname.slice(upstreamBasePath.length) || "/";

  const rewritten = new URL(mapping.localBase.toString());
  rewritten.pathname = joinPaths(mapping.localBase.pathname, relativePath);
  rewritten.search = parsed.search;
  rewritten.hash = parsed.hash;
  return rewritten.toString();
}

function rewritePayloadUrls(value: unknown, mappings: UrlRewriteMapping[]): unknown {
  if (typeof value === "string") {
    return mappings.reduce((current, mapping) => rewriteUrl(current, mapping), value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rewritePayloadUrls(entry, mappings));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, rewritePayloadUrls(entry, mappings)]),
  );
}

export function rewriteCdpBridgePayload(params: {
  payload: unknown;
  upstreamUrl: string;
  localHttpBaseUrl: string;
  localWsBaseUrl?: string;
}): unknown {
  const upstreamBase = new URL(params.upstreamUrl);
  const localHttpBase = new URL(params.localHttpBaseUrl);
  const localWsBase = new URL(
    params.localWsBaseUrl ??
      params.localHttpBaseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:"),
  );
  return rewritePayloadUrls(params.payload, [
    {
      upstreamBase,
      localBase: localHttpBase,
    },
    {
      upstreamBase: new URL(buildUpstreamWsUrl(upstreamBase, "/")),
      localBase: localWsBase,
    },
  ]);
}

function closeSocket(socket: Duplex, status: number, message: string) {
  const body = Buffer.from(message);
  socket.write(
    `HTTP/1.1 ${status} ERR\r\n` +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${body.length}\r\n` +
      "Connection: close\r\n\r\n",
  );
  socket.write(body);
  socket.destroy();
}

async function startServer(
  server: HttpServer,
  bindHost: string,
  port: number,
): Promise<AddressInfo> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bindHost, () => resolve());
  });
  return server.address() as AddressInfo;
}

export async function startLocalCdpBridge(opts: {
  upstreamUrl: string;
  bindHost: string;
  port: number;
}): Promise<LocalCdpBridgeServer> {
  const upstreamBase = new URL(opts.upstreamUrl);
  const wsServer = new WebSocketServer({ noServer: true });
  const activeSockets = new Set<WebSocket>();
  let localHttpBase!: URL;
  let localWsBase!: URL;

  const server = createServer(async (req, res) => {
    try {
      const upstreamUrl = buildUpstreamHttpUrl(upstreamBase, req.url ?? "/");
      const body = await readRequestBody(req);
      const headers = getHeadersWithAuth(upstreamUrl, filterHopByHopHeaders(req.headers));
      const upstreamRes = await withNoProxyForCdpUrl(
        upstreamUrl,
        async () =>
          await fetch(upstreamUrl, {
            method: req.method,
            headers,
            ...(body ? { body } : {}),
          }),
      );

      const contentType = upstreamRes.headers.get("content-type") ?? "";
      const shouldRewriteJson =
        contentType.includes("application/json") || (req.url ?? "").startsWith("/json/");

      res.statusCode = upstreamRes.status;
      res.statusMessage = upstreamRes.statusText;

      if (!shouldRewriteJson) {
        upstreamRes.headers.forEach((value, key) => {
          if (key.toLowerCase() === "content-length") {
            return;
          }
          res.setHeader(key, value);
        });
        const buffer = Buffer.from(await upstreamRes.arrayBuffer());
        res.setHeader("content-length", String(buffer.length));
        res.end(buffer);
        return;
      }

      const raw = await upstreamRes.text();
      let rewritten = raw;
      try {
        const payload = JSON.parse(raw) as unknown;
        const rewrittenPayload = rewriteCdpBridgePayload({
          payload,
          upstreamUrl: upstreamBase.toString(),
          localHttpBaseUrl: localHttpBase.toString(),
          localWsBaseUrl: localWsBase.toString(),
        });
        rewritten = JSON.stringify(rewrittenPayload);
      } catch {
        // Preserve the original body if the upstream claimed JSON but returned invalid content.
      }

      upstreamRes.headers.forEach((value, key) => {
        if (key.toLowerCase() === "content-length") {
          return;
        }
        res.setHeader(key, value);
      });
      res.setHeader("content-length", String(Buffer.byteLength(rewritten)));
      res.end(rewritten);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.statusCode = 502;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(message);
    }
  });

  server.on("upgrade", (req, socket, head) => {
    let targetWsUrl: string;
    try {
      targetWsUrl = buildUpstreamWsUrl(upstreamBase, req.url ?? "/");
    } catch (err) {
      closeSocket(socket, 502, err instanceof Error ? err.message : String(err));
      return;
    }

    wsServer.handleUpgrade(req, socket, head, (clientSocket) => {
      activeSockets.add(clientSocket);
      const pendingClientMessages: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];
      let closed = false;
      const closeBoth = () => {
        if (closed) {
          return;
        }
        closed = true;
        activeSockets.delete(clientSocket);
        try {
          clientSocket.terminate();
        } catch {
          // ignore
        }
      };

      const upstreamSocket = openCdpWebSocket(targetWsUrl);
      activeSockets.add(upstreamSocket);

      const terminateBoth = () => {
        closeBoth();
        activeSockets.delete(upstreamSocket);
        pendingClientMessages.length = 0;
        try {
          upstreamSocket.terminate();
        } catch {
          // ignore
        }
      };

      clientSocket.on("message", (data, isBinary) => {
        if (upstreamSocket.readyState === WebSocket.OPEN) {
          upstreamSocket.send(data, { binary: isBinary });
          return;
        }
        pendingClientMessages.push({ data, isBinary });
      });
      upstreamSocket.on("open", () => {
        for (const pending of pendingClientMessages.splice(0)) {
          upstreamSocket.send(pending.data, { binary: pending.isBinary });
        }
      });
      upstreamSocket.on("message", (data, isBinary) => {
        if (clientSocket.readyState === WebSocket.OPEN) {
          clientSocket.send(data, { binary: isBinary });
        }
      });
      upstreamSocket.on("close", terminateBoth);
      upstreamSocket.on("error", terminateBoth);
      clientSocket.on("close", terminateBoth);
      clientSocket.on("error", terminateBoth);
    });
  });

  server.on("clientError", (err, socket) => {
    closeSocket(socket, 400, err instanceof Error ? err.message : String(err));
  });

  const address = await startServer(server, opts.bindHost, opts.port);
  localHttpBase = new URL(`http://${opts.bindHost}:${address.port}`);
  localWsBase = new URL(`ws://${opts.bindHost}:${address.port}`);

  return {
    bindHost: opts.bindHost,
    port: address.port,
    baseUrl: localHttpBase.toString().replace(/\/$/, ""),
    upstreamUrl: opts.upstreamUrl,
    stop: async () => {
      for (const socket of activeSockets) {
        try {
          socket.terminate();
        } catch {
          // ignore
        }
      }
      activeSockets.clear();
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await Promise.race([
        new Promise<void>((resolve) => wsServer.close(() => resolve())),
        sleep(250),
      ]);
      await Promise.race([
        new Promise<void>((resolve) => server.close(() => resolve())),
        sleep(250),
      ]);
    },
  };
}
