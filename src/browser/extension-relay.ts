import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { loadConfig } from "../config/config.js";
import { isLoopbackAddress, isLoopbackHost } from "../gateway/net.js";
import { rawDataToString } from "../infra/ws.js";

type CdpCommand = {
  id: number;
  method: string;
  params?: unknown;
  sessionId?: string;
};

type CdpResponse = {
  id: number;
  result?: unknown;
  error?: { message: string };
  sessionId?: string;
};

type CdpEvent = {
  method: string;
  params?: unknown;
  sessionId?: string;
};

type ExtensionForwardCommandMessage = {
  id: number;
  method: "forwardCDPCommand";
  params: { method: string; params?: unknown; sessionId?: string };
};

type ExtensionResponseMessage = {
  id: number;
  result?: unknown;
  error?: string;
};

type ExtensionForwardEventMessage = {
  method: "forwardCDPEvent";
  params: { method: string; params?: unknown; sessionId?: string };
};

type ExtensionPingMessage = { method: "ping" };
type ExtensionPongMessage = { method: "pong" };

type ExtensionMessage =
  | ExtensionResponseMessage
  | ExtensionForwardEventMessage
  | ExtensionPongMessage;

type TargetInfo = {
  targetId: string;
  type?: string;
  title?: string;
  url?: string;
  attached?: boolean;
};

type AttachedToTargetEvent = {
  sessionId: string;
  targetInfo: TargetInfo;
  waitingForDebugger?: boolean;
};

type DetachedFromTargetEvent = {
  sessionId: string;
  targetId?: string;
};

type ExtensionConnection = {
  ws: WebSocket;
  name: string;
  id: string;
};

type ConnectedTarget = {
  sessionId: string;
  targetId: string;
  targetInfo: TargetInfo;
  connectionId: string;
};

const RELAY_AUTH_HEADER = "x-openclaw-relay-token";

function headerValue(value: string | string[] | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function getHeader(req: IncomingMessage, name: string): string | undefined {
  return headerValue(req.headers[name.toLowerCase()]);
}

function getRelayAuthTokenFromRequest(req: IncomingMessage, url?: URL): string | undefined {
  const headerToken = getHeader(req, RELAY_AUTH_HEADER)?.trim();
  if (headerToken) {
    return headerToken;
  }
  const queryToken = url?.searchParams.get("token")?.trim();
  if (queryToken) {
    return queryToken;
  }
  return undefined;
}

export type ChromeExtensionRelayServer = {
  host: string;
  port: number;
  baseUrl: string;
  cdpWsUrl: string;
  extensionConnected: () => boolean;
  stop: () => Promise<void>;
};

function parseBaseUrl(raw: string): {
  host: string;
  port: number;
  baseUrl: string;
} {
  const parsed = new URL(raw.trim().replace(/\/$/, ""));
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`extension relay cdpUrl must be http(s), got ${parsed.protocol}`);
  }
  const host = parsed.hostname;
  const port =
    parsed.port?.trim() !== "" ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`extension relay cdpUrl has invalid port: ${parsed.port || "(empty)"}`);
  }
  return { host, port, baseUrl: parsed.toString().replace(/\/$/, "") };
}

function text(res: Duplex, status: number, bodyText: string) {
  const body = Buffer.from(bodyText);
  res.write(
    `HTTP/1.1 ${status} ${status === 200 ? "OK" : "ERR"}\r\n` +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${body.length}\r\n` +
      "Connection: close\r\n" +
      "\r\n",
  );
  res.write(body);
  res.end();
}

function rejectUpgrade(socket: Duplex, status: number, bodyText: string) {
  text(socket, status, bodyText);
  try {
    socket.destroy();
  } catch {
    // ignore
  }
}

const serversByPort = new Map<number, ChromeExtensionRelayServer>();

function resolveGatewayAuthToken(): string | null {
  const envToken =
    process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || process.env.CLAWDBOT_GATEWAY_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }
  try {
    const cfg = loadConfig();
    const configToken = cfg.gateway?.auth?.token?.trim();
    if (configToken) {
      return configToken;
    }
  } catch {
    // ignore config read failures; caller can fallback to per-process random token
  }
  return null;
}

function resolveRelayAuthToken(): string {
  const gatewayToken = resolveGatewayAuthToken();
  if (gatewayToken) {
    return gatewayToken;
  }
  throw new Error(
    "extension relay requires gateway auth token (set gateway.auth.token or OPENCLAW_GATEWAY_TOKEN)",
  );
}

function isAddrInUseError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "EADDRINUSE"
  );
}

async function looksLikeOpenClawRelay(baseUrl: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 500);
  try {
    const statusUrl = new URL("/extension/status", `${baseUrl}/`).toString();
    const res = await fetch(statusUrl, { signal: ctrl.signal });
    if (!res.ok) {
      return false;
    }
    const body = (await res.json()) as { connected?: unknown };
    return typeof body.connected === "boolean";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function relayAuthTokenForUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!isLoopbackHost(parsed.hostname)) {
      return null;
    }
    return resolveGatewayAuthToken();
  } catch {
    return null;
  }
}

export function getChromeExtensionRelayAuthHeaders(url: string): Record<string, string> {
  const token = relayAuthTokenForUrl(url);
  if (!token) {
    return {};
  }
  return { [RELAY_AUTH_HEADER]: token };
}

export async function ensureChromeExtensionRelayServer(opts: {
  cdpUrl: string;
}): Promise<ChromeExtensionRelayServer> {
  const info = parseBaseUrl(opts.cdpUrl);
  if (!isLoopbackHost(info.host)) {
    throw new Error(`extension relay requires loopback cdpUrl host (got ${info.host})`);
  }

  const existing = serversByPort.get(info.port);
  if (existing) {
    return existing;
  }

  const relayAuthToken = resolveRelayAuthToken();

  const extensionConnections = new Map<string, ExtensionConnection>();
  const cdpClients = new Set<WebSocket>();
  const connectedTargets = new Map<string, ConnectedTarget>();

  const pendingExtension = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  let nextExtensionId = 1;

  const getExtensionBySessionId = (
    sessionId?: string,
    requestedRelayName?: string,
  ): ExtensionConnection | null => {
    if (requestedRelayName) {
      for (const conn of extensionConnections.values()) {
        if (conn.name === requestedRelayName) {
          return conn;
        }
      }
    }
    if (!sessionId) {
      return Array.from(extensionConnections.values())[0] ?? null;
    }
    const target = connectedTargets.get(sessionId);
    if (!target) {
      return Array.from(extensionConnections.values())[0] ?? null;
    }
    return extensionConnections.get(target.connectionId) ?? null;
  };

  const sendToExtension = async (
    payload: ExtensionForwardCommandMessage,
    connectionId?: string,
  ): Promise<unknown> => {
    const conn = connectionId
      ? extensionConnections.get(connectionId)
      : getExtensionBySessionId(payload.params.sessionId);

    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Chrome extension not connected");
    }
    conn.ws.send(JSON.stringify(payload));
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingExtension.delete(payload.id);
        reject(new Error(`extension request timeout: ${payload.params.method}`));
      }, 30_000);
      pendingExtension.set(payload.id, { resolve, reject, timer });
    });
  };

  const broadcastToCdpClients = (evt: CdpEvent) => {
    const msg = JSON.stringify(evt);
    for (const ws of cdpClients) {
      if (ws.readyState !== WebSocket.OPEN) {
        continue;
      }
      ws.send(msg);
    }
  };

  const sendResponseToCdp = (ws: WebSocket, res: CdpResponse) => {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(JSON.stringify(res));
  };

  const ensureTargetEventsForClient = (ws: WebSocket, mode: "autoAttach" | "discover") => {
    for (const target of connectedTargets.values()) {
      if (mode === "autoAttach") {
        ws.send(
          JSON.stringify({
            method: "Target.attachedToTarget",
            params: {
              sessionId: target.sessionId,
              targetInfo: { ...target.targetInfo, attached: true },
              waitingForDebugger: false,
            },
          } satisfies CdpEvent),
        );
      } else {
        ws.send(
          JSON.stringify({
            method: "Target.targetCreated",
            params: { targetInfo: { ...target.targetInfo, attached: true } },
          } satisfies CdpEvent),
        );
      }
    }
  };

  const routeCdpCommand = async (
    cmd: CdpCommand,
    requestedRelayName?: string,
  ): Promise<unknown> => {
    switch (cmd.method) {
      case "Browser.getVersion":
        return {
          protocolVersion: "1.3",
          product: "Chrome/OpenClaw-Extension-Relay",
          revision: "0",
          userAgent: "OpenClaw-Extension-Relay",
          jsVersion: "V8",
        };
      case "Browser.setDownloadBehavior":
        return {};
      case "Target.setAutoAttach":
      case "Target.setDiscoverTargets":
        return {};
      case "Target.getTargets":
        return {
          targetInfos: Array.from(connectedTargets.values()).map((t) => ({
            ...t.targetInfo,
            attached: true,
          })),
        };
      case "Target.getTargetInfo": {
        const params = (cmd.params ?? {}) as { targetId?: string };
        const targetId = typeof params.targetId === "string" ? params.targetId : undefined;
        if (targetId) {
          for (const t of connectedTargets.values()) {
            if (t.targetId === targetId) {
              return { targetInfo: t.targetInfo };
            }
          }
        }
        if (cmd.sessionId && connectedTargets.has(cmd.sessionId)) {
          const t = connectedTargets.get(cmd.sessionId);
          if (t) {
            return { targetInfo: t.targetInfo };
          }
        }
        const first = Array.from(connectedTargets.values())[0];
        return { targetInfo: first?.targetInfo };
      }
      case "Target.attachToTarget": {
        const params = (cmd.params ?? {}) as { targetId?: string };
        const targetId = typeof params.targetId === "string" ? params.targetId : undefined;
        if (!targetId) {
          throw new Error("targetId required");
        }
        for (const t of connectedTargets.values()) {
          if (t.targetId === targetId) {
            return { sessionId: t.sessionId };
          }
        }
        throw new Error("target not found");
      }
      default: {
        const id = nextExtensionId++;
        const conn = getExtensionBySessionId(cmd.sessionId, requestedRelayName);
        if (!conn) {
          throw new Error(
            requestedRelayName
              ? `No relay found with name "${requestedRelayName}"`
              : "No attached extension for session",
          );
        }
        return await sendToExtension(
          {
            id,
            method: "forwardCDPCommand",
            params: {
              method: cmd.method,
              sessionId: cmd.sessionId,
              params: cmd.params,
            },
          },
          conn.id,
        );
      }
    }
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", info.baseUrl);
    const path = url.pathname;

    if (path.startsWith("/json")) {
      const token = getHeader(req, RELAY_AUTH_HEADER);
      if (!token || token !== relayAuthToken) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
    }

    if (req.method === "HEAD" && path === "/") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (path === "/") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("OK");
      return;
    }

    if (path === "/extension/status") {
      const connections = Array.from(extensionConnections.values()).map((c) => ({
        id: c.id,
        name: c.name,
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ connected: connections.length > 0, connections }));
      return;
    }

    const hostHeader = req.headers.host?.trim() || `${info.host}:${info.port}`;
    const wsHost = `ws://${hostHeader}`;
    const cdpWsUrl = `${wsHost}/cdp`;

    if (
      (path === "/json/version" || path === "/json/version/") &&
      (req.method === "GET" || req.method === "PUT")
    ) {
      const payload: Record<string, unknown> = {
        Browser: "OpenClaw/extension-relay",
        "Protocol-Version": "1.3",
      };
      // Only advertise the WS URL if at least one extension is connected.
      if (extensionConnections.size > 0) {
        payload.webSocketDebuggerUrl = cdpWsUrl;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }

    const listPaths = new Set(["/json", "/json/", "/json/list", "/json/list/"]);
    if (listPaths.has(path) && (req.method === "GET" || req.method === "PUT")) {
      const list = Array.from(connectedTargets.values()).map((t) => {
        const conn = extensionConnections.get(t.connectionId);
        const titlePrefix = conn?.name ? `[${conn.name}] ` : "";
        return {
          id: t.targetId,
          type: t.targetInfo.type ?? "page",
          title: `${titlePrefix}${t.targetInfo.title ?? ""}`,
          description: t.targetInfo.title ?? "",
          url: t.targetInfo.url ?? "",
          webSocketDebuggerUrl: cdpWsUrl,
          devtoolsFrontendUrl: `/devtools/inspector.html?ws=${cdpWsUrl.replace("ws://", "")}`,
        };
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(list));
      return;
    }

    const activateMatch = path.match(/^\/json\/activate\/(.+)$/);
    if (activateMatch && (req.method === "GET" || req.method === "PUT")) {
      const targetId = decodeURIComponent(activateMatch[1] ?? "").trim();
      if (!targetId) {
        res.writeHead(400);
        res.end("targetId required");
        return;
      }
      void (async () => {
        try {
          const target = Array.from(connectedTargets.values()).find((t) => t.targetId === targetId);
          if (target) {
            await sendToExtension(
              {
                id: nextExtensionId++,
                method: "forwardCDPCommand",
                params: { method: "Target.activateTarget", params: { targetId } },
              },
              target.connectionId,
            );
          }
        } catch {
          // ignore
        }
      })();
      res.writeHead(200);
      res.end("OK");
      return;
    }

    const closeMatch = path.match(/^\/json\/close\/(.+)$/);
    if (closeMatch && (req.method === "GET" || req.method === "PUT")) {
      const targetId = decodeURIComponent(closeMatch[1] ?? "").trim();
      if (!targetId) {
        res.writeHead(400);
        res.end("targetId required");
        return;
      }
      void (async () => {
        try {
          const target = Array.from(connectedTargets.values()).find((t) => t.targetId === targetId);
          if (target) {
            await sendToExtension(
              {
                id: nextExtensionId++,
                method: "forwardCDPCommand",
                params: { method: "Target.closeTarget", params: { targetId } },
              },
              target.connectionId,
            );
          }
        } catch {
          // ignore
        }
      })();
      res.writeHead(200);
      res.end("OK");
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  const wssExtension = new WebSocketServer({ noServer: true });
  const wssCdp = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", info.baseUrl);
    const pathname = url.pathname;
    const remote = req.socket.remoteAddress;

    if (!isLoopbackAddress(remote)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    const origin = headerValue(req.headers.origin);
    if (origin && !origin.startsWith("chrome-extension://")) {
      rejectUpgrade(socket, 403, "Forbidden: invalid origin");
      return;
    }

    if (pathname === "/extension") {
      const token = getRelayAuthTokenFromRequest(req, url);
      if (!token || token !== relayAuthToken) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }
      const requestedName = url.searchParams.get("name")?.trim() || "";
      if (
        requestedName &&
        Array.from(extensionConnections.values()).some((c) => c.name === requestedName)
      ) {
        rejectUpgrade(socket, 409, `Relay name "${requestedName}" already connected`);
        return;
      }
      wssExtension.handleUpgrade(req, socket, head, (ws) => {
        wssExtension.emit("connection", ws, req);
      });
      return;
    }

    if (pathname === "/cdp") {
      const token = getRelayAuthTokenFromRequest(req, url);
      if (!token || token !== relayAuthToken) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }
      if (extensionConnections.size === 0) {
        rejectUpgrade(socket, 503, "No extensions connected");
        return;
      }
      wssCdp.handleUpgrade(req, socket, head, (ws) => {
        wssCdp.emit("connection", ws, req);
      });
      return;
    }

    rejectUpgrade(socket, 404, "Not Found");
  });

  wssExtension.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "/", info.baseUrl);
    const connectionId = crypto.randomUUID();
    const requestedName = url.searchParams.get("name")?.trim() || "";
    const name = requestedName || `relay-${connectionId.slice(0, 8)}`;

    const connection: ExtensionConnection = { ws, name, id: connectionId };
    extensionConnections.set(connectionId, connection);

    const ping = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        return;
      }
      ws.send(JSON.stringify({ method: "ping" } satisfies ExtensionPingMessage));
    }, 5000);

    ws.on("message", (data) => {
      let parsed: ExtensionMessage | null = null;
      try {
        parsed = JSON.parse(rawDataToString(data)) as ExtensionMessage;
      } catch {
        return;
      }

      if (parsed && typeof parsed === "object" && "id" in parsed && typeof parsed.id === "number") {
        const pending = pendingExtension.get(parsed.id);
        if (!pending) {
          return;
        }
        pendingExtension.delete(parsed.id);
        clearTimeout(pending.timer);
        if ("error" in parsed && typeof parsed.error === "string" && parsed.error.trim()) {
          pending.reject(new Error(parsed.error));
        } else {
          pending.resolve(parsed.result);
        }
        return;
      }

      if (parsed && typeof parsed === "object" && "method" in parsed) {
        if ((parsed as ExtensionPongMessage).method === "pong") {
          return;
        }
        if ((parsed as ExtensionForwardEventMessage).method !== "forwardCDPEvent") {
          return;
        }
        const evt = parsed as ExtensionForwardEventMessage;
        const method = evt.params?.method;
        const params = evt.params?.params;
        const sessionId = evt.params?.sessionId;
        if (!method || typeof method !== "string") {
          return;
        }

        if (method === "Target.attachedToTarget") {
          const attached = (params ?? {}) as AttachedToTargetEvent;
          const targetType = attached?.targetInfo?.type ?? "page";
          if (targetType !== "page") {
            return;
          }
          if (attached?.sessionId && attached?.targetInfo?.targetId) {
            const prev = connectedTargets.get(attached.sessionId);
            const nextTargetId = attached.targetInfo.targetId;
            const prevTargetId = prev?.targetId;
            const changedTarget = Boolean(prev && prevTargetId && prevTargetId !== nextTargetId);
            connectedTargets.set(attached.sessionId, {
              sessionId: attached.sessionId,
              targetId: nextTargetId,
              targetInfo: attached.targetInfo,
              connectionId,
            });
            if (changedTarget && prevTargetId) {
              broadcastToCdpClients({
                method: "Target.detachedFromTarget",
                params: { sessionId: attached.sessionId, targetId: prevTargetId },
                sessionId: attached.sessionId,
              });
            }
            if (!prev || changedTarget) {
              broadcastToCdpClients({ method, params, sessionId });
            }
            return;
          }
        }

        if (method === "Target.detachedFromTarget") {
          const detached = (params ?? {}) as DetachedFromTargetEvent;
          if (detached?.sessionId) {
            connectedTargets.delete(detached.sessionId);
          }
          broadcastToCdpClients({ method, params, sessionId });
          return;
        }

        // Keep cached tab metadata fresh for /json/list.
        // After navigation, Chrome updates URL/title via Target.targetInfoChanged.
        if (method === "Target.targetInfoChanged") {
          const changed = (params ?? {}) as { targetInfo?: { targetId?: string; type?: string } };
          const targetInfo = changed?.targetInfo;
          const targetId = targetInfo?.targetId;
          if (targetId && (targetInfo?.type ?? "page") === "page") {
            for (const [sid, target] of connectedTargets) {
              if (target.targetId !== targetId) {
                continue;
              }
              connectedTargets.set(sid, {
                ...target,
                targetInfo: { ...target.targetInfo, ...(targetInfo as object) },
              });
            }
          }
        }

        broadcastToCdpClients({ method, params, sessionId });
      }
    });

    ws.on("close", () => {
      clearInterval(ping);
      extensionConnections.delete(connectionId);

      // Cleanup targets owned by this connection
      for (const [sid, target] of connectedTargets) {
        if (target.connectionId === connectionId) {
          connectedTargets.delete(sid);
          broadcastToCdpClients({
            method: "Target.detachedFromTarget",
            params: { sessionId: sid, targetId: target.targetId },
            sessionId: sid,
          });
        }
      }

      if (extensionConnections.size === 0) {
        for (const client of cdpClients) {
          try {
            client.close(1011, "no extensions connected");
          } catch {
            // ignore
          }
        }
        cdpClients.clear();
      }
    });
  });

  wssCdp.on("connection", (ws, req) => {
    cdpClients.add(ws);

    const cdpUrl = new URL(req.url ?? "/", info.baseUrl);
    const requestedRelayName = cdpUrl.searchParams.get("relay")?.trim() || undefined;

    ws.on("message", async (data) => {
      let cmd: CdpCommand | null = null;
      try {
        cmd = JSON.parse(rawDataToString(data)) as CdpCommand;
      } catch {
        return;
      }
      if (!cmd || typeof cmd !== "object") {
        return;
      }
      if (typeof cmd.id !== "number" || typeof cmd.method !== "string") {
        return;
      }

      if (extensionConnections.size === 0) {
        sendResponseToCdp(ws, {
          id: cmd.id,
          sessionId: cmd.sessionId,
          error: { message: "Extension not connected" },
        });
        return;
      }

      try {
        const result = await routeCdpCommand(cmd, requestedRelayName);

        if (cmd.method === "Target.setAutoAttach" && !cmd.sessionId) {
          ensureTargetEventsForClient(ws, "autoAttach");
        }
        if (cmd.method === "Target.setDiscoverTargets") {
          const discover = (cmd.params ?? {}) as { discover?: boolean };
          if (discover.discover === true) {
            ensureTargetEventsForClient(ws, "discover");
          }
        }
        if (cmd.method === "Target.attachToTarget") {
          const params = (cmd.params ?? {}) as { targetId?: string };
          const targetId = typeof params.targetId === "string" ? params.targetId : undefined;
          if (targetId) {
            const target = Array.from(connectedTargets.values()).find(
              (t) => t.targetId === targetId,
            );
            if (target) {
              ws.send(
                JSON.stringify({
                  method: "Target.attachedToTarget",
                  params: {
                    sessionId: target.sessionId,
                    targetInfo: { ...target.targetInfo, attached: true },
                    waitingForDebugger: false,
                  },
                } satisfies CdpEvent),
              );
            }
          }
        }

        sendResponseToCdp(ws, { id: cmd.id, sessionId: cmd.sessionId, result });
      } catch (err) {
        sendResponseToCdp(ws, {
          id: cmd.id,
          sessionId: cmd.sessionId,
          error: { message: err instanceof Error ? err.message : String(err) },
        });
      }
    });

    ws.on("close", () => {
      cdpClients.delete(ws);
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.listen(info.port, info.host, () => resolve());
      server.once("error", reject);
    });
  } catch (err) {
    if (isAddrInUseError(err) && (await looksLikeOpenClawRelay(info.baseUrl))) {
      const existingRelay: ChromeExtensionRelayServer = {
        host: info.host,
        port: info.port,
        baseUrl: info.baseUrl,
        cdpWsUrl: `ws://${info.host}:${info.port}/cdp`,
        extensionConnected: () => extensionConnections.size > 0,
        stop: async () => {
          serversByPort.delete(info.port);
        },
      };
      serversByPort.set(info.port, existingRelay);
      return existingRelay;
    }
    throw err;
  }

  const addr = server.address() as AddressInfo | null;
  const port = addr?.port ?? info.port;
  const host = info.host;
  const baseUrl = `${new URL(info.baseUrl).protocol}//${host}:${port}`;

  const relay: ChromeExtensionRelayServer = {
    host,
    port,
    baseUrl,
    cdpWsUrl: `ws://${host}:${port}/cdp`,
    extensionConnected: () => extensionConnections.size > 0,
    stop: async () => {
      serversByPort.delete(port);
      for (const conn of extensionConnections.values()) {
        try {
          conn.ws.close(1001, "server stopping");
        } catch {
          // ignore
        }
      }
      for (const ws of cdpClients) {
        try {
          ws.close(1001, "server stopping");
        } catch {
          // ignore
        }
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      wssExtension.close();
      wssCdp.close();
    },
  };

  serversByPort.set(port, relay);
  return relay;
}

export async function stopChromeExtensionRelayServer(opts: { cdpUrl: string }): Promise<boolean> {
  const info = parseBaseUrl(opts.cdpUrl);
  const existing = serversByPort.get(info.port);
  if (!existing) {
    return false;
  }
  await existing.stop();
  return true;
}
// ping Thu Feb 19 15:34:48 CET 2026
