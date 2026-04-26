/**
 * SSE (Server-Sent Events) transport for Control UI.
 *
 * Provides two HTTP endpoints:
 *   GET  /sse      — persistent SSE event stream (replaces WebSocket for server→client push)
 *   POST /sse-rpc  — JSON-RPC over HTTP (replaces WebSocket for client→server requests)
 *
 * Authentication is token-only (Bearer header or ?token= query param).
 * Device identity / pairing / nonce challenge are skipped for simplicity.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBodyWithLimit } from "../infra/http-body.js";
import { isWebchatClient } from "../utils/message-channel.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "./protocol/client-info.js";
import type { ConnectParams } from "./protocol/index.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";
import { GATEWAY_EVENTS, listGatewayMethods } from "./server-methods-list.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./server-methods/types.js";
import { buildGatewaySnapshot } from "./server/health-state.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const SSE_RPC_MAX_BODY_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// Module-level mutable context for RPC. Set by server.impl.ts after startup.
// ---------------------------------------------------------------------------
let _rpcContext: (() => GatewayRequestContext) | null = null;
let _extraHandlers: GatewayRequestHandlers = {};

/**
 * Called from server.impl.ts after the gateway request context is built.
 * This wires up the RPC endpoint so it can dispatch into handleGatewayRequest.
 */
export function setSseRpcContext(
  getContext: () => GatewayRequestContext,
  extraHandlers: GatewayRequestHandlers,
) {
  _rpcContext = getContext;
  _extraHandlers = extraHandlers;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal fake WebSocket interface to satisfy GatewayWsClient.socket usage in broadcast. */
function createSseSocketShim(res: ServerResponse) {
  return {
    send(data: string) {
      if (!res.writableEnded) {
        res.write(`data: ${data}\n\n`);
      }
    },
    close() {
      if (!res.writableEnded) {
        res.end();
      }
    },
    get readyState() {
      return res.writableEnded ? 3 /* CLOSED */ : 1 /* OPEN */;
    },
    get bufferedAmount() {
      return 0;
    },
    ping() {
      /* no-op */
    },
    terminate() {
      if (!res.writableEnded) {
        res.end();
      }
    },
  };
}

function extractToken(req: IncomingMessage): string | undefined {
  // Bearer token from Authorization header
  const auth = req.headers.authorization ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token) {
      return token;
    }
  }
  // Fallback: ?token= query param (EventSource can't set headers)
  const url = new URL(req.url ?? "/", "http://localhost");
  const queryToken = url.searchParams.get("token")?.trim();
  if (queryToken) {
    return queryToken;
  }
  return undefined;
}

function sendJsonResponse(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function buildSseConnectParams(): ConnectParams {
  return {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      displayName: "Control UI (SSE)",
      version: "sse-transport",
      platform: "web",
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
    },
    role: "operator",
    scopes: [
      "operator.admin",
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.pairing",
    ],
    caps: ["tool-events"],
  };
}

function authenticateToken(
  token: string | undefined,
  resolvedAuth: { mode: string; token?: string; password?: string },
): boolean {
  if (resolvedAuth.mode === "none") {
    return true;
  }
  if (!token) {
    return false;
  }
  if (resolvedAuth.token && token === resolvedAuth.token) {
    return true;
  }
  if (resolvedAuth.password && token === resolvedAuth.password) {
    return true;
  }
  return false;
}

// Track SSE clients for RPC correlation
const sseClients = new Map<string, GatewayWsClient>();

// ---------------------------------------------------------------------------
// SSE stream endpoint: GET /sse
// ---------------------------------------------------------------------------

/**
 * Handle GET /sse — persistent SSE event stream.
 * Returns true if the request was handled.
 */
export function handleSseStreamRequest(
  req: IncomingMessage,
  res: ServerResponse,
  params: {
    clients: Set<GatewayWsClient>;
    resolvedAuth: { mode: string; token?: string; password?: string };
    getResolvedAuth?: () => { mode: string; token?: string; password?: string };
  },
): boolean {
  if (req.method !== "GET") {
    return false;
  }

  const resolvedAuth = params.getResolvedAuth?.() ?? params.resolvedAuth;
  const token = extractToken(req);
  if (!authenticateToken(token, resolvedAuth)) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Unauthorized");
    return true;
  }

  // Set SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no", // Disable nginx buffering
  });

  const connId = randomUUID();
  const connectParams = buildSseConnectParams();
  const fakeSocket = createSseSocketShim(res);

  const client: GatewayWsClient = {
    socket: fakeSocket as unknown as GatewayWsClient["socket"],
    connect: connectParams,
    connId,
    usesSharedGatewayAuth: true,
  };

  // Register into the clients set so broadcast() delivers events
  params.clients.add(client);
  sseClients.set(connId, client);

  // Build hello-ok payload
  const snapshot = buildGatewaySnapshot();

  // Send hello-ok as the first SSE event
  const helloOk = {
    type: "event",
    event: "hello-ok",
    payload: {
      type: "hello-ok",
      protocol: PROTOCOL_VERSION,
      server: { version: "sse", connId },
      features: {
        methods: listGatewayMethods(),
        events: [...GATEWAY_EVENTS],
      },
      snapshot,
      policy: { tickIntervalMs: 30_000 },
    },
  };
  res.write(`data: ${JSON.stringify(helloOk)}\n\n`);

  // SSE keep-alive: send a comment every 15s to prevent proxy/browser timeout
  const keepAlive = setInterval(() => {
    if (!res.writableEnded) {
      res.write(": keepalive\n\n");
    }
  }, 15_000);

  // Cleanup on disconnect
  const cleanup = () => {
    clearInterval(keepAlive);
    params.clients.delete(client);
    sseClients.delete(connId);
  };

  req.on("close", cleanup);
  req.on("error", cleanup);
  res.on("close", cleanup);

  return true;
}

// ---------------------------------------------------------------------------
// SSE RPC endpoint: POST /sse-rpc
// ---------------------------------------------------------------------------

/**
 * Handle POST /sse-rpc — JSON-RPC over HTTP for SSE clients.
 * Returns true if the request was handled.
 */
export async function handleSseRpcRequest(
  req: IncomingMessage,
  res: ServerResponse,
  params: {
    resolvedAuth: { mode: string; token?: string; password?: string };
    getResolvedAuth?: () => { mode: string; token?: string; password?: string };
  },
): Promise<boolean> {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return true;
  }
  if (req.method !== "POST") {
    return false;
  }

  // CORS headers for POST
  res.setHeader("Access-Control-Allow-Origin", "*");

  const resolvedAuth = params.getResolvedAuth?.() ?? params.resolvedAuth;
  const token = extractToken(req);
  if (!authenticateToken(token, resolvedAuth)) {
    sendJsonResponse(res, 401, {
      ok: false,
      error: { code: "UNAUTHORIZED", message: "unauthorized" },
    });
    return true;
  }

  if (!_rpcContext) {
    sendJsonResponse(res, 503, {
      ok: false,
      error: { code: "UNAVAILABLE", message: "gateway not ready" },
    });
    return true;
  }

  // Read JSON body
  const bodyResult = await readJsonBodyWithLimit(req, {
    maxBytes: SSE_RPC_MAX_BODY_BYTES,
    emptyObjectOnEmpty: true,
  });
  if (!bodyResult.ok) {
    sendJsonResponse(res, 400, {
      ok: false,
      error: { code: "BAD_REQUEST", message: "invalid request body" },
    });
    return true;
  }

  const body = bodyResult.value as {
    id?: string;
    method?: string;
    params?: unknown;
  };
  if (!body.method || typeof body.method !== "string") {
    sendJsonResponse(res, 400, {
      ok: false,
      error: { code: "BAD_REQUEST", message: "method required" },
    });
    return true;
  }

  // Find any existing SSE client or build an ad-hoc one
  let sseClient: GatewayWsClient | undefined;
  for (const c of sseClients.values()) {
    sseClient = c;
    break;
  }

  const requestClient = sseClient
    ? { connect: sseClient.connect, connId: sseClient.connId }
    : { connect: buildSseConnectParams(), connId: randomUUID() };

  const requestId = body.id ?? randomUUID();

  // Dispatch via handleGatewayRequest
  const context = _rpcContext();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: requestId,
      method: body.method,
      params: body.params,
    },
    client: requestClient,
    isWebchatConnect: (p) => isWebchatClient(p?.client),
    respond: (ok, payload, error) => {
      sendJsonResponse(res, 200, { ok, payload, error });
    },
    context,
    extraHandlers: _extraHandlers,
  });

  return true;
}

/**
 * Check if a request path is an SSE endpoint.
 */
export function isSsePath(pathname: string): boolean {
  return pathname === "/sse" || pathname === "/sse-rpc";
}
