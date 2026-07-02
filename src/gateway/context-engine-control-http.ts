import type { IncomingMessage, ServerResponse } from "node:http";
import { getRuntimeConfig } from "../config/io.js";
import type { ContextEngineControlOperation } from "../context-engine/types.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  getContextEngineControlCapabilities,
  invokeContextEngineControl,
  type ContextEngineControlInput,
  resolveContextEngineControlOperation,
} from "./context-engine-control-shared.js";
import {
  readJsonBodyOrError,
  sendJson,
  sendMethodNotAllowed,
  sendMissingScopeForbidden,
} from "./http-common.js";
import {
  authorizeGatewayHttpRequestOrReply,
  authorizeScopedGatewayHttpRequestOrReply,
  resolveOpenAiCompatibleHttpOperatorScopes,
} from "./http-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";

const DEFAULT_BODY_BYTES = 64 * 1024;
const CAPABILITIES_PATH = "/v1/context-engine/capabilities";
const CONTROL_PATH = "/v1/context-engine/control";
const CAPABILITIES_OPERATOR_METHOD = "contextEngine.capabilities";
const CONTROL_OPERATOR_METHODS: Record<ContextEngineControlOperation, string> = {
  status: "contextEngine.status",
  doctor: "contextEngine.doctor",
  rotate: "contextEngine.rotate",
};

function resolveControlOperatorMethod(input: ContextEngineControlInput): string {
  const operation = resolveContextEngineControlOperation(input.operation);
  return operation ? CONTROL_OPERATOR_METHODS[operation] : CONTROL_OPERATOR_METHODS.status;
}

/** Handle authenticated context-engine control routes. */
export async function handleContextEngineControlHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    maxBodyBytes?: number;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  } catch {
    sendJson(res, 400, {
      ok: false,
      error: { type: "invalid_request", message: "Invalid request URL" },
    });
    return true;
  }

  if (url.pathname !== CAPABILITIES_PATH && url.pathname !== CONTROL_PATH) {
    return false;
  }

  if (url.pathname === CAPABILITIES_PATH) {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }
    const authResult = await authorizeScopedGatewayHttpRequestOrReply({
      req,
      res,
      auth: opts.auth,
      trustedProxies: opts.trustedProxies,
      allowRealIpFallback: opts.allowRealIpFallback,
      rateLimiter: opts.rateLimiter,
      operatorMethod: CAPABILITIES_OPERATOR_METHOD,
      resolveOperatorScopes: resolveOpenAiCompatibleHttpOperatorScopes,
    });
    if (!authResult) {
      return true;
    }
    const { cfg } = authResult;
    const outcome = await getContextEngineControlCapabilities({
      cfg,
      agentId: url.searchParams.get("agentId"),
    });
    sendJson(
      res,
      outcome.status,
      outcome.ok ? { ok: true, result: outcome.result } : { ok: false, error: outcome.error },
    );
    return true;
  }

  const cfg = getRuntimeConfig();
  const requestAuth = await authorizeGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies ?? cfg.gateway?.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback ?? cfg.gateway?.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
  if (!requestAuth) {
    return true;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  const bodyUnknown = await readJsonBodyOrError(req, res, opts.maxBodyBytes ?? DEFAULT_BODY_BYTES);
  if (bodyUnknown === undefined) {
    return true;
  }
  const input = (bodyUnknown ?? {}) as ContextEngineControlInput;
  const operatorScopes = resolveOpenAiCompatibleHttpOperatorScopes(req, requestAuth);
  const scopeAuth = authorizeOperatorScopesForMethod(
    resolveControlOperatorMethod(input),
    operatorScopes,
  );
  if (!scopeAuth.allowed) {
    sendMissingScopeForbidden(res, scopeAuth.missingScope);
    return true;
  }
  const outcome = await invokeContextEngineControl({
    cfg,
    input,
  });
  if (!outcome.ok && outcome.error.retryAfterMs) {
    res.setHeader("Retry-After", String(Math.ceil(outcome.error.retryAfterMs / 1000)));
  }
  sendJson(
    res,
    outcome.status,
    outcome.ok ? { ok: true, result: outcome.result } : { ok: false, error: outcome.error },
  );
  return true;
}
