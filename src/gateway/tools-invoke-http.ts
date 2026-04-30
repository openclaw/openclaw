import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  readJsonBodyOrError,
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
} from "./http-common.js";
import {
  authorizeScopedGatewayHttpRequestOrReply,
  getHeader,
  resolveOpenAiCompatibleHttpOperatorScopes,
  resolveOpenAiCompatibleHttpSenderIsOwner,
} from "./http-utils.js";
import { invokeGatewayTool } from "./tools-invoke-core.js";

const DEFAULT_BODY_BYTES = 2 * 1024 * 1024;

type ToolsInvokeBody = {
  tool?: unknown;
  action?: unknown;
  args?: unknown;
  sessionKey?: unknown;
  dryRun?: unknown;
};

function resolveSessionKeyFromBody(body: ToolsInvokeBody): string | undefined {
  if (typeof body.sessionKey === "string" && body.sessionKey.trim()) {
    return body.sessionKey.trim();
  }
  return undefined;
}

export async function handleToolsInvokeHttpRequest(
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
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "bad_request", message: "Invalid request URL" }));
    return true;
  }
  if (url.pathname !== "/tools/invoke") {
    return false;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  // /tools/invoke intentionally uses the same shared-secret HTTP trust model as
  // the OpenAI-compatible APIs: token/password bearer auth is full operator
  // access for the gateway, not a narrower per-request scope boundary.
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
  const { cfg, requestAuth } = authResult;

  const bodyUnknown = await readJsonBodyOrError(req, res, opts.maxBodyBytes ?? DEFAULT_BODY_BYTES);
  if (bodyUnknown === undefined) {
    return true;
  }
  const body = (bodyUnknown ?? {}) as ToolsInvokeBody;

  const toolName = normalizeOptionalString(body.tool) ?? "";
  if (!toolName) {
    sendInvalidRequest(res, "tools.invoke requires body.tool");
    return true;
  }

  // Resolve message channel/account hints (optional headers) for policy inheritance.
  const messageChannel = normalizeMessageChannel(
    getHeader(req, "x-openclaw-message-channel") ?? "",
  );
  const accountId = normalizeOptionalString(getHeader(req, "x-openclaw-account-id"));
  const agentTo = normalizeOptionalString(getHeader(req, "x-openclaw-message-to"));
  const agentThreadId = normalizeOptionalString(getHeader(req, "x-openclaw-thread-id"));
  // Owner semantics intentionally follow the same shared-secret HTTP contract
  // on this direct tool surface; SECURITY.md documents this as designed-as-is.
  // Computed before resolveGatewayScopedTools so the message tool is created
  // with the correct owner context and channel-action gates (e.g. Matrix set-profile)
  // work correctly for both owner and non-owner callers.
  const senderIsOwner = resolveOpenAiCompatibleHttpSenderIsOwner(req, requestAuth);
  const invokeResult = await invokeGatewayTool({
    cfg,
    toolName,
    action: normalizeOptionalString(body.action),
    args: body.args,
    sessionKey: resolveSessionKeyFromBody(body),
    senderIsOwner,
    messageProvider: messageChannel ?? undefined,
    accountId,
    agentTo,
    agentThreadId,
    surface: "http",
    confirm: true,
    idempotencyKey: `http-${Date.now()}`,
  });
  if (invokeResult.body.ok) {
    sendJson(res, invokeResult.status, { ok: true, result: invokeResult.body.output });
    return true;
  }
  const { toolName: _toolName, ...errorBody } = invokeResult.body;
  sendJson(res, invokeResult.status, errorBody);

  return true;
}
