import type { IncomingMessage, ServerResponse } from "node:http";
import { setSseHeaders, sendJson, sendMethodNotAllowed } from "../http-common.js";
import { readJsonBody } from "../hooks.js";
import { resolveClientIp } from "../net.js";

type EventsHttpOptions = {
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
};

type SseClient = {
  res: ServerResponse;
  ip: string;
  closed: boolean;
  heartbeat: ReturnType<typeof setInterval> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  queue: string[];
  lastActivity: number;
};

const SSE_PATH = "/api/events/stream";
const EVENTS_POST_PATH = "/api/events";

const MAX_SSE_CONNECTIONS = (() => {
  const raw = process.env.MAX_SSE_CONNECTIONS?.trim();
  const n = raw ? Number.parseInt(raw, 10) : 100;
  return Number.isFinite(n) && n > 0 ? n : 100;
})();
const MAX_SSE_PER_IP = (() => {
  const raw = process.env.MAX_SSE_PER_IP?.trim();
  const n = raw ? Number.parseInt(raw, 10) : 5;
  return Number.isFinite(n) && n > 0 ? n : 5;
})();
const SSE_IDLE_TIMEOUT_MS = (() => {
  const raw = process.env.SSE_IDLE_TIMEOUT_SECONDS?.trim();
  const n = raw ? Number.parseInt(raw, 10) : 120;
  return Number.isFinite(n) && n > 0 ? n * 1000 : 120_000;
})();
const SSE_QUEUE_MAX = (() => {
  const raw = process.env.SSE_QUEUE_MAX?.trim();
  const n = raw ? Number.parseInt(raw, 10) : 100;
  return Number.isFinite(n) && n > 0 ? n : 100;
})();

const EVENT_RATE_LIMIT_PER_IP = (() => {
  const raw = process.env.EVENT_RATE_LIMIT_PER_IP?.trim();
  const n = raw ? Number.parseInt(raw, 10) : 60;
  return Number.isFinite(n) && n > 0 ? n : 60;
})();
const EVENT_RATE_WINDOW_SECONDS = (() => {
  const raw = process.env.EVENT_RATE_WINDOW_SECONDS?.trim();
  const n = raw ? Number.parseInt(raw, 10) : 60;
  return Number.isFinite(n) && n > 0 ? n : 60;
})();
const EVENT_BODY_MAX_BYTES = 64 * 1024;

const sseClients = new Set<SseClient>();
const perIpConnections = new Map<string, number>();
const rateLimitTimestamps = new Map<string, number[]>();

function incIp(ip: string) {
  perIpConnections.set(ip, (perIpConnections.get(ip) ?? 0) + 1);
}
function decIp(ip: string) {
  const prev = perIpConnections.get(ip) ?? 0;
  if (prev <= 1) {
    perIpConnections.delete(ip);
  } else {
    perIpConnections.set(ip, prev - 1);
  }
}

function write(res: ServerResponse, data: string) {
  res.write(data);
}
function writeEvent(res: ServerResponse, event: string, data: unknown) {
  write(res, `event: ${event}\n`);
  write(res, `data: ${JSON.stringify(data)}\n\n`);
}

function heartbeatFor(client: SseClient): ReturnType<typeof setInterval> {
  return setInterval(() => {
    if (client.closed) {
      return;
    }
    write(client.res, ": keep-alive\n\n");
  }, 20_000);
}
function resetIdle(client: SseClient) {
  if (SSE_IDLE_TIMEOUT_MS <= 0) {
    return;
  }
  if (client.idleTimer) {
    clearTimeout(client.idleTimer);
  }
  client.idleTimer = setTimeout(() => {
    if (!client.closed) {
      try {
        client.res.end();
      } catch {}
    }
  }, SSE_IDLE_TIMEOUT_MS);
}

function enqueue(client: SseClient, payload: string) {
  if (client.queue.length >= SSE_QUEUE_MAX) {
    client.queue.shift();
  }
  client.queue.push(payload);
  flush(client);
}

function flush(client: SseClient) {
  if (client.closed) {
    return;
  }
  while (client.queue.length > 0) {
    const next = client.queue.shift();
    if (next === undefined) {
      break;
    }
    write(client.res, next);
  }
  resetIdle(client);
}

function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    enqueue(client, payload);
  }
}

function resolveIp(req: IncomingMessage, opts: EventsHttpOptions): string {
  const ip = resolveClientIp({
    remoteAddr: req.socket?.remoteAddress,
    forwardedFor:
      typeof req.headers["x-forwarded-for"] === "string"
        ? req.headers["x-forwarded-for"]
        : Array.isArray(req.headers["x-forwarded-for"])
          ? req.headers["x-forwarded-for"][0]
          : undefined,
    realIp:
      typeof req.headers["x-real-ip"] === "string"
        ? req.headers["x-real-ip"]
        : Array.isArray(req.headers["x-real-ip"])
          ? req.headers["x-real-ip"][0]
          : undefined,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
  });
  return ip ?? "unknown";
}

function checkRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  const windowMs = EVENT_RATE_WINDOW_SECONDS * 1000;
  const now = Date.now();
  const cutoff = now - windowMs;
  const list = rateLimitTimestamps.get(ip) ?? [];
  const recent = list.filter((ts) => ts >= cutoff);
  if (recent.length >= EVENT_RATE_LIMIT_PER_IP) {
    const retryAfterMs = recent[0] + windowMs - now;
    return { allowed: false, retryAfter: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }
  recent.push(now);
  rateLimitTimestamps.set(ip, recent);
  return { allowed: true };
}

export async function handleEventsHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: EventsHttpOptions = {},
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (pathname === EVENTS_POST_PATH) {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, "POST");
      return true;
    }
    const ip = resolveIp(req, opts);
    const limit = checkRateLimit(ip);
    if (!limit.allowed) {
      if (limit.retryAfter && limit.retryAfter > 0) {
        res.setHeader("Retry-After", String(limit.retryAfter));
      }
      sendJson(res, 429, { error: { message: "Too Many Requests", type: "rate_limited" } });
      return true;
    }
    const body = await readJsonBody(req, EVENT_BODY_MAX_BYTES);
    if (!body.ok) {
      const status =
        body.error === "payload too large"
          ? 413
          : body.error === "request body timeout"
            ? 408
            : 400;
      sendJson(res, status, { ok: false, error: body.error });
      return true;
    }
    broadcast("event", body.value);
    sendJson(res, 202, { ok: true });
    return true;
  }

  if (pathname === SSE_PATH) {
    if (req.method === "HEAD") {
      res.statusCode = 200;
      res.end();
      return true;
    }
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET, HEAD");
      return true;
    }

    if (sseClients.size >= MAX_SSE_CONNECTIONS) {
      sendJson(res, 503, { error: { message: "Server busy", type: "overloaded" } });
      return true;
    }
    const ip = resolveIp(req, opts);
    const perIp = perIpConnections.get(ip) ?? 0;
    if (perIp >= MAX_SSE_PER_IP) {
      sendJson(res, 429, { error: { message: "Too many connections", type: "rate_limited" } });
      return true;
    }

    setSseHeaders(res);
    const client: SseClient = {
      res,
      ip,
      closed: false,
      heartbeat: null,
      idleTimer: null,
      queue: [],
      lastActivity: Date.now(),
    };
    sseClients.add(client);
    incIp(ip);
    client.heartbeat = heartbeatFor(client);
    resetIdle(client);

    req.socket?.on("close", () => {
      if (client.closed) return;
      client.closed = true;
      sseClients.delete(client);
      decIp(ip);
      if (client.heartbeat) {
        clearInterval(client.heartbeat);
        client.heartbeat = null;
      }
      if (client.idleTimer) {
        clearTimeout(client.idleTimer);
        client.idleTimer = null;
      }
    });

    writeEvent(res, "ready", { ts: Date.now() });
    return true;
  }

  return false;
}
