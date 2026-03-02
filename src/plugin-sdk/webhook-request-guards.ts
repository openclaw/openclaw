import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBodyWithLimit, requestBodyErrorToText } from "../infra/http-body.js";
import type { FixedWindowRateLimiter } from "./webhook-memory-guards.js";

export function isJsonContentType(value: string | string[] | undefined): boolean {
  const first = Array.isArray(value) ? value[0] : value;
  if (!first) {
    return false;
  }
  const mediaType = first.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"));
}

export function applyBasicWebhookRequestGuards(params: {
  req: IncomingMessage;
  res: ServerResponse;
  allowMethods?: readonly string[];
  rateLimiter?: FixedWindowRateLimiter;
  rateLimitKey?: string;
  nowMs?: number;
  requireJsonContentType?: boolean;
}): boolean {
  const allowMethods = params.allowMethods?.length ? params.allowMethods : null;
  if (allowMethods && !allowMethods.includes(params.req.method ?? "")) {
    params.res.statusCode = 405;
    params.res.setHeader("Allow", allowMethods.join(", "));
    params.res.end("Method Not Allowed");
    return false;
  }

  if (
    params.rateLimiter &&
    params.rateLimitKey &&
    params.rateLimiter.isRateLimited(params.rateLimitKey, params.nowMs ?? Date.now())
  ) {
    params.res.statusCode = 429;
    params.res.end("Too Many Requests");
    return false;
  }

  if (
    params.requireJsonContentType &&
    params.req.method === "POST" &&
    !isJsonContentType(params.req.headers["content-type"])
  ) {
    params.res.statusCode = 415;
    params.res.end("Unsupported Media Type");
    return false;
  }

  return true;
}

export async function readJsonWebhookBodyOrReject(params: {
  req: IncomingMessage;
  res: ServerResponse;
  maxBytes: number;
  timeoutMs?: number;
  emptyObjectOnEmpty?: boolean;
  invalidJsonMessage?: string;
}): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const body = await readJsonBodyWithLimit(params.req, {
    maxBytes: params.maxBytes,
    timeoutMs: params.timeoutMs,
    emptyObjectOnEmpty: params.emptyObjectOnEmpty,
  });
  if (body.ok) {
    return { ok: true, value: body.value };
  }

  params.res.statusCode =
    body.code === "PAYLOAD_TOO_LARGE" ? 413 : body.code === "REQUEST_BODY_TIMEOUT" ? 408 : 400;
  const message =
    body.code === "PAYLOAD_TOO_LARGE"
      ? requestBodyErrorToText("PAYLOAD_TOO_LARGE")
      : body.code === "REQUEST_BODY_TIMEOUT"
        ? requestBodyErrorToText("REQUEST_BODY_TIMEOUT")
        : (params.invalidJsonMessage ?? "Bad Request");
  params.res.end(message);
  return { ok: false };
}
