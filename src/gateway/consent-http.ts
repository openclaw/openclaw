/**
 * HTTP API for ConsentGate status and revoke.
 * Protected by gateway auth; used by Control UI in live mode.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig } from "../config/config.js";
import { resolveConsentGateApi } from "../consent/resolve.js";
import type { ConsentRevokeInput, ConsentStatusQuery } from "../consent/types.js";
import { readWalEventsFromStorage } from "../consent/wal-file.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { authorizeGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import { readJsonBodyOrError, sendGatewayAuthFailure, sendJson } from "./http-common.js";
import { getBearerToken } from "./http-utils.js";

const CONSENT_API_PREFIX = "/api/consent/";
const STATUS_PATH = "/api/consent/status";
const REVOKE_PATH = "/api/consent/revoke";
const METRICS_PATH = "/api/consent/metrics";
const EXPORT_PATH = "/api/consent/export";
const QUARANTINE_LIFT_PATH = "/api/consent/quarantine/lift";
const MAX_BODY_BYTES = 4 * 1024;
const MAX_STATUS_LIMIT = 1_000;
const MAX_EXPORT_LIMIT = 10_000;

export type HandleConsentHttpRequestParams = {
  auth: ResolvedGatewayAuth;
  trustedProxies: string[];
  rateLimiter?: AuthRateLimiter;
};

function parseOptionalInteger(
  raw: string | null,
  opts: { min: number; max?: number; field: string },
): { ok: true; value: number | undefined } | { ok: false; message: string } {
  if (raw == null || raw.trim() === "") {
    return { ok: true, value: undefined };
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return { ok: false, message: `${opts.field} must be an integer` };
  }
  if (value < opts.min) {
    return { ok: false, message: `${opts.field} must be >= ${opts.min}` };
  }
  if (opts.max != null && value > opts.max) {
    return { ok: false, message: `${opts.field} must be <= ${opts.max}` };
  }
  return { ok: true, value };
}

/**
 * Handle GET /api/consent/status and POST /api/consent/revoke.
 * Returns true if the request was handled.
 */
export async function handleConsentHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  params: HandleConsentHttpRequestParams,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;
  if (!pathname.startsWith(CONSENT_API_PREFIX)) {
    return false;
  }

  const token = getBearerToken(req);
  const authResult = await authorizeGatewayConnect({
    auth: params.auth,
    connectAuth: token ? { token, password: token } : null,
    req,
    trustedProxies: params.trustedProxies,
    rateLimiter: params.rateLimiter,
  });
  if (!authResult.ok) {
    sendGatewayAuthFailure(res, authResult);
    return true;
  }

  if (pathname === STATUS_PATH && req.method === "GET") {
    const sinceMsRaw = parseOptionalInteger(url.searchParams.get("sinceMs"), {
      min: 0,
      field: "sinceMs",
    });
    if (!sinceMsRaw.ok) {
      sendJson(res, 400, { error: { message: sinceMsRaw.message, type: "invalid_request_error" } });
      return true;
    }
    const limitRaw = parseOptionalInteger(url.searchParams.get("limit"), {
      min: 1,
      max: MAX_STATUS_LIMIT,
      field: "limit",
    });
    if (!limitRaw.ok) {
      sendJson(res, 400, { error: { message: limitRaw.message, type: "invalid_request_error" } });
      return true;
    }
    const cfg = loadConfig();
    const api = resolveConsentGateApi(cfg);
    const sessionKey = url.searchParams.get("sessionKey")?.trim() ?? undefined;
    const tenantId = url.searchParams.get("tenantId")?.trim() ?? undefined;
    const query: ConsentStatusQuery = {
      sessionKey,
      tenantId: tenantId || undefined,
      sinceMs: sinceMsRaw.value,
      limit: limitRaw.value,
    };
    const snapshot = await api.status(query);
    sendJson(res, 200, snapshot);
    return true;
  }

  if (pathname === REVOKE_PATH && req.method === "POST") {
    const body = await readJsonBodyOrError(req, res, MAX_BODY_BYTES);
    if (body === undefined) return true;
    const input = body as Record<string, unknown>;
    const revokeInput: ConsentRevokeInput = {
      jti: typeof input.jti === "string" ? input.jti.trim() || undefined : undefined,
      sessionKey: typeof input.sessionKey === "string" ? input.sessionKey.trim() || undefined : undefined,
      tenantId: typeof input.tenantId === "string" ? input.tenantId.trim() || undefined : undefined,
    };
    if (!revokeInput.jti && !revokeInput.sessionKey && !revokeInput.tenantId) {
      sendJson(res, 400, { error: { message: "One of jti, sessionKey, or tenantId is required", type: "invalid_request_error" } });
      return true;
    }
    const cfg = loadConfig();
    const api = resolveConsentGateApi(cfg);
    const result = await api.revoke(revokeInput);
    sendJson(res, 200, result);
    return true;
  }

  if (pathname === QUARANTINE_LIFT_PATH && req.method === "POST") {
    const body = await readJsonBodyOrError(req, res, MAX_BODY_BYTES);
    if (body === undefined) return true;
    const input = body as Record<string, unknown>;
    const sessionKey = typeof input.sessionKey === "string" ? input.sessionKey.trim() : "";
    if (!sessionKey) {
      sendJson(res, 400, {
        error: { message: "sessionKey is required", type: "invalid_request_error" },
      });
      return true;
    }
    const cfg = loadConfig();
    const api = resolveConsentGateApi(cfg);
    api.liftQuarantine?.(sessionKey);
    sendJson(res, 200, { lifted: true });
    return true;
  }

  if (pathname === METRICS_PATH && req.method === "GET") {
    const cfg = loadConfig();
    const api = resolveConsentGateApi(cfg);
    const snapshot = api.getMetrics?.() ?? { issues: 0, consumes: 0, revokes: 0, denialsByReason: {}, quarantine: 0, failClosed: 0 };
    sendJson(res, 200, snapshot);
    return true;
  }

  if (pathname === EXPORT_PATH && req.method === "GET") {
    const cfg = loadConfig();
    const storagePath = cfg.gateway?.consentGate?.storagePath?.trim();
    if (!storagePath) {
      sendJson(res, 400, {
        error: {
          message: "WAL export requires gateway.consentGate.storagePath to be set",
          type: "invalid_request_error",
        },
      });
      return true;
    }
    const sinceMsRaw = parseOptionalInteger(url.searchParams.get("sinceMs"), {
      min: 0,
      field: "sinceMs",
    });
    if (!sinceMsRaw.ok) {
      sendJson(res, 400, { error: { message: sinceMsRaw.message, type: "invalid_request_error" } });
      return true;
    }
    const untilMsRaw = parseOptionalInteger(url.searchParams.get("untilMs"), {
      min: 0,
      field: "untilMs",
    });
    if (!untilMsRaw.ok) {
      sendJson(res, 400, { error: { message: untilMsRaw.message, type: "invalid_request_error" } });
      return true;
    }
    if (
      sinceMsRaw.value != null &&
      untilMsRaw.value != null &&
      sinceMsRaw.value > untilMsRaw.value
    ) {
      sendJson(res, 400, {
        error: { message: "sinceMs must be <= untilMs", type: "invalid_request_error" },
      });
      return true;
    }
    const limitRaw = parseOptionalInteger(url.searchParams.get("limit"), {
      min: 1,
      max: MAX_EXPORT_LIMIT,
      field: "limit",
    });
    if (!limitRaw.ok) {
      sendJson(res, 400, { error: { message: limitRaw.message, type: "invalid_request_error" } });
      return true;
    }
    const correlationIdRaw = url.searchParams.get("correlationId");
    const correlationId = correlationIdRaw?.trim() ? correlationIdRaw.trim() : undefined;
    const limit = limitRaw.value ?? 1000;
    const events = readWalEventsFromStorage(storagePath, {
      sinceMs: sinceMsRaw.value,
      untilMs: untilMsRaw.value,
      limit,
      correlationId,
    });
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=consentgate-wal.jsonl");
    res.end(events.map((e) => JSON.stringify(e)).join("\n"));
    return true;
  }

  if (pathname.startsWith(CONSENT_API_PREFIX)) {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: { message: "Method Not Allowed", type: "method_not_allowed" } }));
    return true;
  }

  return false;
}
