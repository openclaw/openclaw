import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { isLoopbackAddress, isLoopbackHost } from "../gateway/net.js";
import { rawDataToString } from "../infra/ws.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("browser").child("extension-relay");
import {
  probeAuthenticatedOpenClawRelay,
  resolveRelayAcceptedTokensForPort,
  resolveRelayAuthTokenForPort,
} from "./extension-relay-auth.js";

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

type ConnectedTarget = {
  sessionId: string;
  targetId: string;
  targetInfo: TargetInfo;
};

const RELAY_AUTH_HEADER = "x-openclaw-relay-token";
const DEFAULT_EXTENSION_RECONNECT_GRACE_MS = 20_000;
const DEFAULT_EXTENSION_COMMAND_RECONNECT_WAIT_MS = 3_000;

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
  bindHost: string;
  port: number;
  baseUrl: string;
  cdpWsUrl: string;
  extensionConnected: () => boolean;
  stop: () => Promise<void>;
};

type RelayRuntime = {
  server: ChromeExtensionRelayServer;
  relayAuthToken: string;
};

function parseUrlPort(parsed: URL): number | null {
  const port =
    parsed.port?.trim() !== "" ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return null;
  }
  return port;
}

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
  const port = parseUrlPort(parsed);
  if (!port) {
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

function envMsOrDefault(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

const relayRuntimeByPort = new Map<number, RelayRuntime>();
const relayInitByPort = new Map<number, Promise<ChromeExtensionRelayServer>>();

function isAddrInUseError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "EADDRINUSE"
  );
}

function relayAuthTokenForUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!isLoopbackHost(parsed.hostname)) {
      return null;
    }
    const port = parseUrlPort(parsed);
    if (!port) {
      return null;
    }
    return relayRuntimeByPort.get(port)?.relayAuthToken ?? null;
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
  bindHost?: string;
}): Promise<ChromeExtensionRelayServer> {
  const info = parseBaseUrl(opts.cdpUrl);
  if (!isLoopbackHost(info.host)) {
    throw new Error(`extension relay requires loopback cdpUrl host (got ${info.host})`);
  }
  const bindHost = opts.bindHost ?? info.host;

  const existing = relayRuntimeByPort.get(info.port);
  if (existing) {
    if (existing.server.bindHost !== bindHost) {
      log.debug(`relay on port ${info.port} has different bindHost, restarting`);
      await existing.server.stop();
    } else {
      log.debug(`relay already running on port ${info.port}, reusing`);
      return existing.server;
    }
  }

  const inFlight = relayInitByPort.get(info.port);
  if (inFlight) {
    log.debug(`relay init already in-flight for port ${info.port}, awaiting`);
    const server = await inFlight;
    if (server.bindHost === bindHost) {
      return server;
    }
    await server.stop();
  }

  log.info(`initializing relay server for ${info.baseUrl}`);

  const extensionReconnectGraceMs = envMsOrDefault(
    "OPENCLAW_EXTENSION_RELAY_RECONNECT_GRACE_MS",
    DEFAULT_EXTENSION_RECONNECT_GRACE_MS,
  );
  const extensionCommandReconnectWaitMs = envMsOrDefault(
    "OPENCLAW_EXTENSION_RELAY_COMMAND_RECONNECT_WAIT_MS",
    DEFAULT_EXTENSION_COMMAND_RECONNECT_WAIT_MS,
  );

  const initPromise = (async (): Promise<ChromeExtensionRelayServer> => {
    const relayAuthToken = await resolveRelayAuthTokenForPort(info.port);
    const relayAuthTokens = new Set(await resolveRelayAcceptedTokensForPort(info.port));

    let extensionWs: WebSocket | null = null;
    const cdpClients = new Set<WebSocket>();
    const connectedTargets = new Map<string, ConnectedTarget>();
    const extensionConnected = () => extensionWs?.readyState === WebSocket.OPEN;
    const hasConnectedTargets = () => connectedTargets.size > 0;
    let extensionDisconnectCleanupTimer: NodeJS.Timeout | null = null;
    const extensionReconnectWaiters = new Set<(connected: boolean) => void>();

    const flushExtensionReconnectWaiters = (connected: boolean) => {
      if (extensionReconnectWaiters.size === 0) {
        return;
      }
      const waiters = Array.from(extensionReconnectWaiters);
      extensionReconnectWaiters.clear();
      for (const waiter of waiters) {
        waiter(connected);
      }
    };

    const clearExtensionDisconnectCleanupTimer = () => {
      if (!extensionDisconnectCleanupTimer) {
        return;
      }
      clearTimeout(extensionDisconnectCleanupTimer);
      extensionDisconnectCleanupTimer = null;
    };

    const closeCdpClientsAfterExtensionDisconnect = () => {
      log.warn(
        `extension disconnect cleanup: clearing ${connectedTargets.size} targets, closing ${cdpClients.size} CDP clients`,
      );
      connectedTargets.clear();
      for (const client of cdpClients) {
        try {
          client.close(1011, "extension disconnected");
        } catch {
          // ignore
        }
      }
      cdpClients.clear();
      flushExtensionReconnectWaiters(false);
    };

    const scheduleExtensionDisconnectCleanup = () => {
      clearExtensionDisconnectCleanupTimer();
      log.info(`scheduling extension disconnect cleanup in ${extensionReconnectGraceMs}ms`);
      extensionDisconnectCleanupTimer = setTimeout(() => {
        extensionDisconnectCleanupTimer = null;
        if (extensionConnected()) {
          log.info("extension reconnected before cleanup timer fired, skipping cleanup");
          return;
        }
        closeCdpClientsAfterExtensionDisconnect();
      }, extensionReconnectGraceMs);
    };

    const waitForExtensionReconnect = async (timeoutMs: number): Promise<boolean> => {
      if (extensionConnected()) {
        return true;
      }
      return await new Promise<boolean>((resolve) => {
        let settled = false;
        const waiter = (connected: boolean) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          extensionReconnectWaiters.delete(waiter);
          resolve(connected);
        };
        const timer = setTimeout(() => {
          waiter(false);
        }, timeoutMs);
        extensionReconnectWaiters.add(waiter);
      });
    };

    const pendingExtension = new Map<
      number,
      {
        resolve: (v: unknown) => void;
        reject: (e: Error) => void;
        timer: NodeJS.Timeout;
      }
    >();
    let nextExtensionId = 1;

    const sendToExtension = async (payload: ExtensionForwardCommandMessage): Promise<unknown> => {
      const ws = extensionWs;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        log.warn(
          `sendToExtension failed: extension not connected (method=${payload.params.method})`,
        );
        throw new Error("Chrome extension not connected");
      }
      log.debug(
        `forwarding to extension: ${payload.params.method}${payload.params.sessionId ? ` sessionId=${payload.params.sessionId}` : ""}`,
      );
      ws.send(JSON.stringify(payload));
      return await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingExtension.delete(payload.id);
          log.error(`extension request timeout: ${payload.params.method} (id=${payload.id})`);
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

    const dropConnectedTargetSession = (sessionId: string): ConnectedTarget | undefined => {
      const existing = connectedTargets.get(sessionId);
      if (!existing) {
        return undefined;
      }
      connectedTargets.delete(sessionId);
      log.info(
        `dropped target session: sessionId=${sessionId} targetId=${existing.targetId} (remaining=${connectedTargets.size})`,
      );
      return existing;
    };

    const dropConnectedTargetsByTargetId = (targetId: string): ConnectedTarget[] => {
      const removed: ConnectedTarget[] = [];
      for (const [sessionId, target] of connectedTargets) {
        if (target.targetId !== targetId) {
          continue;
        }
        connectedTargets.delete(sessionId);
        removed.push(target);
      }
      if (removed.length > 0) {
        log.info(
          `dropped ${removed.length} target(s) by targetId=${targetId} (remaining=${connectedTargets.size})`,
        );
      }
      return removed;
    };

    const broadcastDetachedTarget = (target: ConnectedTarget, targetId?: string) => {
      broadcastToCdpClients({
        method: "Target.detachedFromTarget",
        params: {
          sessionId: target.sessionId,
          targetId: targetId ?? target.targetId,
        },
        sessionId: target.sessionId,
      });
    };

    const isMissingTargetError = (err: unknown) => {
      const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
      return (
        message.includes("target not found") ||
        message.includes("no target with given id") ||
        message.includes("session not found") ||
        message.includes("cannot find session")
      );
    };

    const pruneStaleTargetsFromCommandFailure = (cmd: CdpCommand, err: unknown) => {
      if (!isMissingTargetError(err)) {
        return;
      }
      log.warn(
        `pruning stale targets after command failure: method=${cmd.method} error=${err instanceof Error ? err.message : String(err)}`,
      );
      if (cmd.sessionId) {
        const removed = dropConnectedTargetSession(cmd.sessionId);
        if (removed) {
          broadcastDetachedTarget(removed);
          return;
        }
      }
      const params = (cmd.params ?? {}) as { targetId?: unknown };
      const targetId = typeof params.targetId === "string" ? params.targetId : undefined;
      if (!targetId) {
        return;
      }
      const removedTargets = dropConnectedTargetsByTargetId(targetId);
      for (const removed of removedTargets) {
        broadcastDetachedTarget(removed, targetId);
      }
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

    const routeCdpCommand = async (cmd: CdpCommand): Promise<unknown> => {
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
        case "Target.attachToBrowserTarget": {
          // Playwright calls this to create a browser-level CDP session before
          // calling Target.attachToTarget for per-page sessions. Return a synthetic
          // sessionId — subsequent commands on it route through the same switch.
          const browserSessionId = `browser-session-${nextExtensionId++}`;
          log.info(
            `Target.attachToBrowserTarget: returning synthetic sessionId=${browserSessionId}`,
          );
          return { sessionId: browserSessionId };
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
          return await sendToExtension({
            id,
            method: "forwardCDPCommand",
            params: {
              method: cmd.method,
              sessionId: cmd.sessionId,
              params: cmd.params,
            },
          });
        }
      }
    };

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", info.baseUrl);
      const path = url.pathname;
      const origin = getHeader(req, "origin");
      const isChromeExtensionOrigin =
        typeof origin === "string" && origin.startsWith("chrome-extension://");

      if (isChromeExtensionOrigin && origin) {
        // Let extension pages call relay HTTP endpoints cross-origin.
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }

      // Handle CORS preflight requests from the browser extension.
      if (req.method === "OPTIONS") {
        if (origin && !isChromeExtensionOrigin) {
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }
        const requestedHeaders = (getHeader(req, "access-control-request-headers") ?? "")
          .split(",")
          .map((header) => header.trim().toLowerCase())
          .filter((header) => header.length > 0);
        const allowedHeaders = new Set(["content-type", RELAY_AUTH_HEADER, ...requestedHeaders]);
        res.writeHead(204, {
          "Access-Control-Allow-Origin": origin ?? "*",
          "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
          "Access-Control-Allow-Headers": Array.from(allowedHeaders).join(", "),
          "Access-Control-Max-Age": "86400",
          Vary: "Origin, Access-Control-Request-Headers",
        });
        res.end();
        return;
      }

      if (path.startsWith("/json")) {
        const token = getRelayAuthTokenFromRequest(req, url);
        if (!token || !relayAuthTokens.has(token)) {
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
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ connected: extensionConnected() }));
        return;
      }

      // [lilac-start] push signal asking extension to attach a tab
      if (path === "/extension/request-tab-attach" && req.method === "POST") {
        const ws = extensionWs;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          res.writeHead(503);
          res.end("extension not connected");
          return;
        }
        ws.send(JSON.stringify({ method: "requestTabAttach" }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ sent: true }));
        return;
      }
      // [lilac-end]

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
        // Keep reporting CDP WS while attached targets are cached, so callers can
        // reconnect through brief MV3 worker disconnects.
        if (extensionConnected() || hasConnectedTargets()) {
          payload.webSocketDebuggerUrl = cdpWsUrl;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
        return;
      }

      const listPaths = new Set(["/json", "/json/", "/json/list", "/json/list/"]);
      if (listPaths.has(path) && (req.method === "GET" || req.method === "PUT")) {
        log.debug(`/json/list: returning ${connectedTargets.size} tab(s)`);
        const list = Array.from(connectedTargets.values()).map((t) => ({
          id: t.targetId,
          type: t.targetInfo.type ?? "page",
          title: t.targetInfo.title ?? "",
          description: t.targetInfo.title ?? "",
          url: t.targetInfo.url ?? "",
          webSocketDebuggerUrl: cdpWsUrl,
          devtoolsFrontendUrl: `/devtools/inspector.html?ws=${cdpWsUrl.replace("ws://", "")}`,
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(list));
        return;
      }

      const handleTargetActionRoute = (
        match: RegExpMatchArray | null,
        cdpMethod: "Target.activateTarget" | "Target.closeTarget",
      ): boolean => {
        if (!match || (req.method !== "GET" && req.method !== "PUT")) {
          return false;
        }
        let targetId = "";
        try {
          targetId = decodeURIComponent(match[1] ?? "").trim();
        } catch {
          res.writeHead(400);
          res.end("invalid targetId encoding");
          return true;
        }
        if (!targetId) {
          res.writeHead(400);
          res.end("targetId required");
          return true;
        }
        void (async () => {
          try {
            await sendToExtension({
              id: nextExtensionId++,
              method: "forwardCDPCommand",
              params: { method: cdpMethod, params: { targetId } },
            });
          } catch {
            // ignore
          }
        })();
        res.writeHead(200);
        res.end("OK");
        return true;
      };

      if (
        handleTargetActionRoute(path.match(/^\/json\/activate\/(.+)$/), "Target.activateTarget")
      ) {
        return;
      }
      if (handleTargetActionRoute(path.match(/^\/json\/close\/(.+)$/), "Target.closeTarget")) {
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

      // When bindHost is explicitly non-loopback (e.g. 0.0.0.0 for WSL2),
      // allow non-loopback connections; otherwise enforce loopback-only.
      if (!isLoopbackAddress(remote) && isLoopbackHost(bindHost)) {
        log.warn(`rejected WebSocket upgrade from non-loopback address: ${remote}`);
        rejectUpgrade(socket, 403, "Forbidden");
        return;
      }

      const origin = headerValue(req.headers.origin);
      if (origin && !origin.startsWith("chrome-extension://")) {
        log.warn(`rejected WebSocket upgrade with invalid origin: ${origin}`);
        rejectUpgrade(socket, 403, "Forbidden: invalid origin");
        return;
      }

      if (pathname === "/extension") {
        const token = getRelayAuthTokenFromRequest(req, url);
        if (!token || !relayAuthTokens.has(token)) {
          log.warn("rejected extension WebSocket upgrade: unauthorized");
          rejectUpgrade(socket, 401, "Unauthorized");
          return;
        }
        // MV3 worker reconnect races can leave a stale non-OPEN socket reference.
        if (extensionWs && extensionWs.readyState !== WebSocket.OPEN) {
          log.info(
            "terminating stale extension WebSocket reference before accepting new connection",
          );
          try {
            extensionWs.terminate();
          } catch {
            // ignore
          }
          extensionWs = null;
        }
        if (extensionConnected()) {
          log.warn("rejected extension WebSocket upgrade: already connected");
          rejectUpgrade(socket, 409, "Extension already connected");
          return;
        }
        wssExtension.handleUpgrade(req, socket, head, (ws) => {
          wssExtension.emit("connection", ws, req);
        });
        return;
      }

      if (pathname === "/cdp") {
        const token = getRelayAuthTokenFromRequest(req, url);
        if (!token || !relayAuthTokens.has(token)) {
          log.warn("rejected CDP WebSocket upgrade: unauthorized");
          rejectUpgrade(socket, 401, "Unauthorized");
          return;
        }
        log.debug("accepting CDP client WebSocket upgrade");
        // Allow CDP clients to connect even during brief extension worker drops.
        // Individual commands already wait briefly for extension reconnect.
        wssCdp.handleUpgrade(req, socket, head, (ws) => {
          wssCdp.emit("connection", ws, req);
        });
        return;
      }

      rejectUpgrade(socket, 404, "Not Found");
    });

    wssExtension.on("connection", (ws) => {
      log.info("extension WebSocket connected");
      extensionWs = ws;
      clearExtensionDisconnectCleanupTimer();
      flushExtensionReconnectWaiters(true);

      const ping = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          return;
        }
        ws.send(JSON.stringify({ method: "ping" } satisfies ExtensionPingMessage));
      }, 5000);

      ws.on("message", (data) => {
        if (extensionWs !== ws) {
          return;
        }
        let parsed: ExtensionMessage | null = null;
        try {
          parsed = JSON.parse(rawDataToString(data)) as ExtensionMessage;
        } catch {
          return;
        }

        if (
          parsed &&
          typeof parsed === "object" &&
          "id" in parsed &&
          typeof parsed.id === "number"
        ) {
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
              log.debug(
                `ignoring Target.attachedToTarget for non-page type=${targetType} targetId=${attached?.targetInfo?.targetId}`,
              );
              return;
            }
            if (attached?.sessionId && attached?.targetInfo?.targetId) {
              const prev = connectedTargets.get(attached.sessionId);
              const nextTargetId = attached.targetInfo.targetId;
              const prevTargetId = prev?.targetId;
              const changedTarget = Boolean(prev && prevTargetId && prevTargetId !== nextTargetId);
              log.info(
                `Target.attachedToTarget: sessionId=${attached.sessionId} targetId=${nextTargetId}${changedTarget ? ` (replaced targetId=${prevTargetId})` : prev ? " (duplicate, no change)" : " (new)"}` +
                  ` url=${attached.targetInfo.url ?? "(none)"} (total=${connectedTargets.size + (prev ? 0 : 1)})`,
              );
              connectedTargets.set(attached.sessionId, {
                sessionId: attached.sessionId,
                targetId: nextTargetId,
                targetInfo: attached.targetInfo,
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
            log.info(
              `Target.detachedFromTarget: sessionId=${detached?.sessionId ?? "(none)"} targetId=${detached?.targetId ?? "(none)"}`,
            );
            if (detached?.sessionId) {
              dropConnectedTargetSession(detached.sessionId);
            } else if (detached?.targetId) {
              dropConnectedTargetsByTargetId(detached.targetId);
            }
            broadcastToCdpClients({ method, params, sessionId });
            return;
          }

          if (method === "Target.targetDestroyed" || method === "Target.targetCrashed") {
            const targetEvent = (params ?? {}) as { targetId?: string };
            log.info(`${method}: targetId=${targetEvent.targetId ?? "(none)"}`);
            if (targetEvent.targetId) {
              dropConnectedTargetsByTargetId(targetEvent.targetId);
            }
            broadcastToCdpClients({ method, params, sessionId });
            return;
          }

          // Keep cached tab metadata fresh for /json/list.
          // After navigation, Chrome updates URL/title via Target.targetInfoChanged.
          if (method === "Target.targetInfoChanged") {
            const changed = (params ?? {}) as {
              targetInfo?: { targetId?: string; type?: string; url?: string; title?: string };
            };
            const targetInfo = changed?.targetInfo;
            const targetId = targetInfo?.targetId;
            if (targetId && (targetInfo?.type ?? "page") === "page") {
              let matched = false;
              for (const [sid, target] of connectedTargets) {
                if (target.targetId !== targetId) {
                  continue;
                }
                matched = true;
                connectedTargets.set(sid, {
                  ...target,
                  targetInfo: { ...target.targetInfo, ...(targetInfo as object) },
                });
              }
              log.debug(
                `Target.targetInfoChanged: targetId=${targetId} matched=${matched} url=${targetInfo?.url ?? "(none)"}`,
              );
            }
          }

          broadcastToCdpClients({ method, params, sessionId });
        }
      });

      ws.on("close", (code, reason) => {
        log.info(
          `extension WebSocket disconnected: code=${code} reason=${reason?.toString() || "(none)"} pendingCommands=${pendingExtension.size}`,
        );
        clearInterval(ping);
        if (extensionWs !== ws) {
          log.debug("ignoring close from stale extension WebSocket reference");
          return;
        }
        extensionWs = null;
        for (const [, pending] of pendingExtension) {
          clearTimeout(pending.timer);
          pending.reject(new Error("extension disconnected"));
        }
        pendingExtension.clear();
        scheduleExtensionDisconnectCleanup();
      });
    });

    wssCdp.on("connection", (ws) => {
      cdpClients.add(ws);
      log.info(`CDP client connected (total=${cdpClients.size})`);

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

        if (!extensionConnected()) {
          log.debug(
            `extension not connected for CDP command ${cmd.method}, waiting ${extensionCommandReconnectWaitMs}ms for reconnect`,
          );
          const reconnected = await waitForExtensionReconnect(extensionCommandReconnectWaitMs);
          if (!reconnected || !extensionConnected()) {
            log.warn(
              `extension reconnect failed for CDP command ${cmd.method}, returning error to client`,
            );
            sendResponseToCdp(ws, {
              id: cmd.id,
              sessionId: cmd.sessionId,
              error: { message: "Extension not connected" },
            });
            return;
          }
          log.debug(`extension reconnected, proceeding with command ${cmd.method}`);
        }

        try {
          const result = await routeCdpCommand(cmd);

          if (cmd.method === "Target.setAutoAttach" && !cmd.sessionId) {
            ensureTargetEventsForClient(ws, "autoAttach");
          }
          if (cmd.method === "Target.setDiscoverTargets") {
            const discover = (cmd.params ?? {}) as { discover?: boolean };
            if (discover.discover === true) {
              ensureTargetEventsForClient(ws, "discover");
            }
          }
          // Note: we intentionally do NOT send Target.attachedToTarget after
          // Target.attachToTarget here. All targets in connectedTargets were already
          // announced to CDP clients via ensureTargetEventsForClient (triggered by
          // Target.setAutoAttach). Sending the event again causes Playwright's
          // _onAttachedToTarget to assert "Duplicate target" and crash.
          // Playwright only needs the command response ({ sessionId }), not the event.

          sendResponseToCdp(ws, { id: cmd.id, sessionId: cmd.sessionId, result });
        } catch (err) {
          log.warn(
            `CDP command failed: method=${cmd.method} error=${err instanceof Error ? err.message : String(err)}`,
          );
          pruneStaleTargetsFromCommandFailure(cmd, err);
          sendResponseToCdp(ws, {
            id: cmd.id,
            sessionId: cmd.sessionId,
            error: { message: err instanceof Error ? err.message : String(err) },
          });
        }
      });

      ws.on("close", () => {
        cdpClients.delete(ws);
        log.info(`CDP client disconnected (remaining=${cdpClients.size})`);
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.listen(info.port, bindHost, () => resolve());
        server.once("error", reject);
      });
    } catch (err) {
      if (
        isAddrInUseError(err) &&
        (await probeAuthenticatedOpenClawRelay({
          baseUrl: info.baseUrl,
          relayAuthHeader: RELAY_AUTH_HEADER,
          relayAuthToken,
        }))
      ) {
        log.info(
          `port ${info.port} already in use by authenticated openclaw relay, reusing existing server`,
        );
        const existingRelay: ChromeExtensionRelayServer = {
          host: info.host,
          bindHost,
          port: info.port,
          baseUrl: info.baseUrl,
          cdpWsUrl: `ws://${info.host}:${info.port}/cdp`,
          extensionConnected: () => false,
          stop: async () => {
            relayRuntimeByPort.delete(info.port);
          },
        };
        relayRuntimeByPort.set(info.port, { server: existingRelay, relayAuthToken });
        return existingRelay;
      }
      throw err;
    }

    const addr = server.address() as AddressInfo | null;
    const port = addr?.port ?? info.port;
    const actualBindHost = addr?.address || bindHost;
    const host = info.host;
    const baseUrl = `${new URL(info.baseUrl).protocol}//${host}:${port}`;

    log.info(`relay server listening on ${baseUrl}`);

    const relay: ChromeExtensionRelayServer = {
      host,
      bindHost: actualBindHost,
      port,
      baseUrl,
      cdpWsUrl: `ws://${host}:${port}/cdp`,
      extensionConnected,
      stop: async () => {
        log.info(`stopping relay server on port ${port}`);
        relayRuntimeByPort.delete(port);
        clearExtensionDisconnectCleanupTimer();
        flushExtensionReconnectWaiters(false);
        for (const [, pending] of pendingExtension) {
          clearTimeout(pending.timer);
          pending.reject(new Error("server stopping"));
        }
        pendingExtension.clear();
        try {
          extensionWs?.close(1001, "server stopping");
        } catch {
          // ignore
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

    relayRuntimeByPort.set(port, { server: relay, relayAuthToken });
    return relay;
  })();
  relayInitByPort.set(info.port, initPromise);
  try {
    return await initPromise;
  } finally {
    relayInitByPort.delete(info.port);
  }
}

export async function stopChromeExtensionRelayServer(opts: { cdpUrl: string }): Promise<boolean> {
  const info = parseBaseUrl(opts.cdpUrl);
  const existing = relayRuntimeByPort.get(info.port);
  if (!existing) {
    return false;
  }
  await existing.server.stop();
  return true;
}
