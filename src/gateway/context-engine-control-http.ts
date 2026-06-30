import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  getContextEngineControlCapabilities,
  invokeContextEngineControl,
  type ContextEngineControlInput,
} from "./context-engine-control-shared.js";
import { readJsonBodyOrError, sendJson, sendMethodNotAllowed } from "./http-common.js";
import {
  authorizeScopedGatewayHttpRequestOrReply,
  resolveOpenAiCompatibleHttpOperatorScopes,
} from "./http-utils.js";

const DEFAULT_BODY_BYTES = 64 * 1024;
const CAPABILITIES_PATH = "/v1/context-engine/capabilities";
const CONTROL_PATH = "/v1/context-engine/control";

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

  const authResult = await authorizeScopedGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    operatorMethod: "agent",
    resolveOperatorScopes: resolveOpenAiCompatibleHttpOperatorScopes,
  });
  if (!authResult) {
    return true;
  }
  const { cfg } = authResult;

  if (url.pathname === CAPABILITIES_PATH) {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }
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

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  const bodyUnknown = await readJsonBodyOrError(req, res, opts.maxBodyBytes ?? DEFAULT_BODY_BYTES);
  if (bodyUnknown === undefined) {
    return true;
  }
  const outcome = await invokeContextEngineControl({
    cfg,
    input: (bodyUnknown ?? {}) as ContextEngineControlInput,
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
