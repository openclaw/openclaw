import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isRequestBodyLimitError,
  readJsonBodyWithLimit,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "../infra/http-body.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import type { FixedWindowRateLimiter } from "./webhook-memory-guards.js";

export type WebhookBodyReadProfile = "pre-auth" | "post-auth";

export const WEBHOOK_BODY_READ_DEFAULTS = Object.freeze({
  preAuth: {
    maxBytes: 64 * 1024,
    timeoutMs: 5_000,
  },
  postAuth: {
    maxBytes: 1024 * 1024,
    timeoutMs: 30_000,
  },
});

export const WEBHOOK_IN_FLIGHT_DEFAULTS = Object.freeze({
  maxInFlightPerKey: 8,
  maxTrackedKeys: 4_096,
});

export type WebhookInFlightLimiter = {
  tryAcquire: (key: string) => boolean;
  release: (key: string) => void;
  size: () => number;
  clear: () => void;
};

function resolveWebhookBodyReadLimits(params: {
  maxBytes?: number;
  timeoutMs?: number;
  profile?: WebhookBodyReadProfile;
}): { maxBytes: number; timeoutMs: number } {
  const defaults =
    params.profile === "pre-auth"
      ? WEBHOOK_BODY_READ_DEFAULTS.preAuth
      : WEBHOOK_BODY_READ_DEFAULTS.postAuth;
  const maxBytes =
    typeof params.maxBytes === "number" && Number.isFinite(params.maxBytes) && params.maxBytes > 0
      ? Math.floor(params.maxBytes)
      : defaults.maxBytes;
  const timeoutMs =
    typeof params.timeoutMs === "number" &&
    Number.isFinite(params.timeoutMs) &&
    params.timeoutMs > 0
      ? Math.floor(params.timeoutMs)
      : defaults.timeoutMs;
  return { maxBytes, timeoutMs };
}

export function createWebhookInFlightLimiter(options?: {
  maxInFlightPerKey?: number;
  maxTrackedKeys?: number;
}): WebhookInFlightLimiter {
  const maxInFlightPerKey = Math.max(
    1,
    Math.floor(options?.maxInFlightPerKey ?? WEBHOOK_IN_FLIGHT_DEFAULTS.maxInFlightPerKey),
  );
  const maxTrackedKeys = Math.max(
    1,
    Math.floor(options?.maxTrackedKeys ?? WEBHOOK_IN_FLIGHT_DEFAULTS.maxTrackedKeys),
  );
  const active = new Map<string, number>();

  return {
    tryAcquire: (key: string) => {
      if (!key) {
        return true;
      }
      const current = active.get(key) ?? 0;
      if (current >= maxInFlightPerKey) {
        return false;
      }
      active.set(key, current + 1);
      pruneMapToMaxSize(active, maxTrackedKeys);
      return true;
    },
    release: (key: string) => {
      if (!key) {
        return;
      }
      const current = active.get(key);
      if (current === undefined) {
        return;
      }
      if (current <= 1) {
        active.delete(key);
        return;
      }
      active.set(key, current - 1);
    },
    size: () => active.size,
    clear: () => active.clear(),
  };
}

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

export function beginWebhookRequestPipelineOrReject(params: {
  req: IncomingMessage;
  res: ServerResponse;
  allowMethods?: readonly string[];
  rateLimiter?: FixedWindowRateLimiter;
  rateLimitKey?: string;
  nowMs?: number;
  requireJsonContentType?: boolean;
  inFlightLimiter?: WebhookInFlightLimiter;
  inFlightKey?: string;
  inFlightLimitStatusCode?: number;
  inFlightLimitMessage?: string;
}): { ok: true; release: () => void } | { ok: false } {
  if (
    !applyBasicWebhookRequestGuards({
      req: params.req,
      res: params.res,
      allowMethods: params.allowMethods,
      rateLimiter: params.rateLimiter,
      rateLimitKey: params.rateLimitKey,
      nowMs: params.nowMs,
      requireJsonContentType: params.requireJsonContentType,
    })
  ) {
    return { ok: false };
  }

  const inFlightKey = params.inFlightKey ?? "";
  const inFlightLimiter = params.inFlightLimiter;
  if (inFlightLimiter && inFlightKey && !inFlightLimiter.tryAcquire(inFlightKey)) {
    params.res.statusCode = params.inFlightLimitStatusCode ?? 429;
    params.res.end(params.inFlightLimitMessage ?? "Too Many Requests");
    return { ok: false };
  }

  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      if (inFlightLimiter && inFlightKey) {
        inFlightLimiter.release(inFlightKey);
      }
    },
  };
}

export async function readWebhookBodyOrReject(params: {
  req: IncomingMessage;
  res: ServerResponse;
  maxBytes?: number;
  timeoutMs?: number;
  profile?: WebhookBodyReadProfile;
  invalidBodyMessage?: string;
}): Promise<{ ok: true; value: string } | { ok: false }> {
  const limits = resolveWebhookBodyReadLimits({
    maxBytes: params.maxBytes,
    timeoutMs: params.timeoutMs,
    profile: params.profile,
  });

  try {
    const raw = await readRequestBodyWithLimit(params.req, limits);
    return { ok: true, value: raw };
  } catch (error) {
    if (isRequestBodyLimitError(error)) {
      params.res.statusCode =
        error.code === "PAYLOAD_TOO_LARGE"
          ? 413
          : error.code === "REQUEST_BODY_TIMEOUT"
            ? 408
            : 400;
      params.res.end(requestBodyErrorToText(error.code));
      return { ok: false };
    }
    params.res.statusCode = 400;
    params.res.end(
      params.invalidBodyMessage ?? (error instanceof Error ? error.message : String(error)),
    );
    return { ok: false };
  }
}

export async function readJsonWebhookBodyOrReject(params: {
  req: IncomingMessage;
  res: ServerResponse;
  maxBytes?: number;
  timeoutMs?: number;
  profile?: WebhookBodyReadProfile;
  emptyObjectOnEmpty?: boolean;
  invalidJsonMessage?: string;
}): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const limits = resolveWebhookBodyReadLimits({
    maxBytes: params.maxBytes,
    timeoutMs: params.timeoutMs,
    profile: params.profile,
  });
  const body = await readJsonBodyWithLimit(params.req, {
    maxBytes: limits.maxBytes,
    timeoutMs: limits.timeoutMs,
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
