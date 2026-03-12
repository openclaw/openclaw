import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayAuthResult } from "./auth.js";
import { readJsonBody } from "./hooks.js";

/**
 * Apply baseline security headers for all HTTP responses.
 *
 * X-Frame-Options defaults to DENY to prevent clickjacking on API/UI routes.
 * Handlers that intentionally serve framed content (canvas host, A2UI) should
 * override or remove it after calling this function.
 *
 * Content-Security-Policy is intentionally omitted because framing policy
 * differs per handler; the control UI sets its own strict CSP.
 */
export function setDefaultSecurityHeaders(
  res: ServerResponse,
  opts?: { strictTransportSecurity?: string },
) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
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

/**
 * Returns true if the request Content-Type is acceptable for JSON endpoints.
 * Accepts `application/json` (with optional charset/boundary params) and
 * missing Content-Type (for backwards compat with curl/scripts that omit it).
 */
function isJsonContentType(req: IncomingMessage): boolean {
  const ct = req.headers["content-type"];
  if (!ct) {
    return true; // allow missing for CLI/script compat
  }
  // Extract media type before any parameters (charset, boundary, etc.)
  const mediaType = ct.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

export async function readJsonBodyOrError(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
): Promise<unknown> {
  if (!isJsonContentType(req)) {
    sendJson(res, 415, {
      error: {
        message: "Unsupported Media Type. Expected application/json.",
        type: "invalid_request_error",
      },
    });
    return undefined;
  }
  const body = await readJsonBody(req, maxBytes);
  if (!body.ok) {
    if (body.error === "payload too large") {
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
