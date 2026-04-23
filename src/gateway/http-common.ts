import type { IncomingMessage, ServerResponse } from "node:http";
import {
  logRejectedLargePayload,
  parseContentLengthHeader,
} from "../logging/diagnostic-payload.js";
import type { GatewayAuthResult } from "./auth.js";
import { readJsonBody } from "./hooks.js";

/**
 * Apply baseline security headers that are safe for all response types (API JSON,
 * HTML pages, static assets, SSE streams). Headers that restrict framing or set a
 * Content-Security-Policy are intentionally omitted here because some handlers
 * (canvas host, A2UI) serve content that may be loaded inside frames.
 */
export function setDefaultSecurityHeaders(
  res: ServerResponse,
  opts?: { strictTransportSecurity?: string },
) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(self), geolocation=()");
  const strictTransportSecurity = opts?.strictTransportSecurity;
  if (typeof strictTransportSecurity === "string" && strictTransportSecurity.length > 0) {
    res.setHeader("Strict-Transport-Security", strictTransportSecurity);
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function sendText(res: ServerResponse, status: number, body: string) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

export function sendMethodNotAllowed(res: ServerResponse, allow = "POST") {
  res.setHeader("Allow", allow);
  sendText(res, 405, "Method Not Allowed");
}

export function sendUnauthorized(res: ServerResponse) {
  sendJson(res, 401, {
    error: { message: "Unauthorized", type: "unauthorized" },
  });
}

export function sendRateLimited(res: ServerResponse, retryAfterMs?: number) {
  if (retryAfterMs && retryAfterMs > 0) {
    res.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
  }
  sendJson(res, 429, {
    error: {
      message: "Too many failed authentication attempts. Please try again later.",
      type: "rate_limited",
    },
  });
}

export function sendGatewayAuthFailure(res: ServerResponse, authResult: GatewayAuthResult) {
  if (authResult.rateLimited) {
    sendRateLimited(res, authResult.retryAfterMs);
    return;
  }
  sendUnauthorized(res);
}

export function sendInvalidRequest(res: ServerResponse, message: string) {
  sendJson(res, 400, {
    error: { message, type: "invalid_request_error" },
  });
}

export async function readJsonBodyOrError(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
): Promise<unknown> {
  const body = await readJsonBody(req, maxBytes);
  if (!body.ok) {
    if (body.error === "payload too large") {
      const contentLength = parseContentLengthHeader(req.headers?.["content-length"]);
      logRejectedLargePayload({
        surface: "gateway.http.json",
        limitBytes: maxBytes,
        reason: "json_body_limit",
        ...(contentLength !== undefined ? { bytes: contentLength } : {}),
      });
      sendJson(res, 413, {
        error: { message: "Payload too large", type: "invalid_request_error" },
      });
      return undefined;
    }
    if (body.error === "request body timeout") {
      sendJson(res, 408, {
        error: { message: "Request body timeout", type: "invalid_request_error" },
      });
      return undefined;
    }
    sendInvalidRequest(res, body.error);
    return undefined;
  }
  return body.value;
}

export function writeDone(res: ServerResponse) {
  res.write("data: [DONE]\n\n");
}

export function setSseHeaders(res: ServerResponse) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
}

/**
 * Keep SSE streams alive through idle-timeout proxies (e.g. Envoy's default
 * 4-minute stream idle timeout, ALB's 60s, Cloudflare's 100s) by periodically
 * writing an SSE comment line. Comment lines (`: ...\n\n`) are valid SSE per
 * the spec and are ignored by clients, but any bytes on the wire reset
 * intermediary idle timers.
 *
 * Backpressure-aware: when a slow client or congested proxy causes
 * `res.write()` to return false, the heartbeat pauses until the response
 * emits `drain`. This prevents unbounded per-connection buffering that could
 * be amplified into a DoS by many concurrent slow readers (CWE-400).
 *
 * The returned stop function clears the interval. The helper also auto-stops
 * on `close`/`finish` so callers that already end the response through
 * existing paths do not need to track cleanup manually.
 */
export function startSseHeartbeat(
  res: ServerResponse,
  options?: { intervalMs?: number },
): () => void {
  const intervalMs = Math.max(1000, options?.intervalMs ?? 30_000);
  let stopped = false;
  let waitingForDrain = false;

  const tick = () => {
    if (stopped || waitingForDrain || res.writableEnded || res.destroyed) {
      return;
    }
    const flushed = res.write(": ping\n\n");
    if (!flushed) {
      // Slow client or congested proxy: pause heartbeats until the socket
      // drains so we do not pile up buffered comments in memory. The real
      // event writes (deltas, completion) use the same res.write() and will
      // experience the same backpressure through Node's internal buffering,
      // but the heartbeat should not contribute additional pressure.
      waitingForDrain = true;
      res.once("drain", () => {
        waitingForDrain = false;
      });
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
  };
  res.once("close", stop);
  res.once("finish", stop);
  return stop;
}

export function watchClientDisconnect(
  req: IncomingMessage,
  res: ServerResponse,
  abortController: AbortController,
  onDisconnect?: () => void,
) {
  const sockets = Array.from(
    new Set(
      [req.socket, res.socket].filter(
        (socket): socket is NonNullable<typeof socket> => socket !== null,
      ),
    ),
  );
  if (sockets.length === 0) {
    return () => {};
  }
  const handleClose = () => {
    onDisconnect?.();
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
  };
  for (const socket of sockets) {
    socket.on("close", handleClose);
  }
  return () => {
    for (const socket of sockets) {
      socket.off("close", handleClose);
    }
  };
}
