import type { IncomingMessage, ServerResponse } from "node:http";
/**
 * Marketplace HTTP endpoint — buyer-facing API.
 *
 * POST /v1/marketplace/completions
 *
 * OpenAI-compatible endpoint that routes requests through idle seller nodes
 * in the P2P marketplace. Follows the same auth + billing pattern as the
 * existing /v1/chat/completions endpoint.
 */
import { randomUUID } from "node:crypto";
import type { MarketplaceConfig } from "../config/types.gateway.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { MarketplaceProxyDonePayload } from "./marketplace/events.js";
import type { MarketplaceScheduler } from "./marketplace/scheduler.js";
import type { NodeRegistry } from "./node-registry.js";
import { checkBillingAllowance } from "./billing/billing-gate.js";
import { reportUsage } from "./billing/usage-reporter.js";
import { sendJson, setSseHeaders, writeDone } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import { calculateMarketplacePrice, type MarketplaceTransaction } from "./marketplace/billing.js";
import { marketplaceEventBus, type MarketplaceProxyEvent } from "./marketplace/event-bus.js";
import { resolveTenantContext } from "./tenant-context.js";

const MARKETPLACE_PATH = "/v1/marketplace/completions";
const PROXY_TIMEOUT_MS = 120_000;

export type MarketplaceHttpOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  rateLimiter?: AuthRateLimiter;
  iamConfig?: import("../config/config.js").GatewayIamConfig;
  nodeRegistry: NodeRegistry;
  scheduler: MarketplaceScheduler;
  marketplaceConfig: MarketplaceConfig;
};

/**
 * Handle a marketplace HTTP request.
 * Returns true if the request was handled (even if with an error response).
 */
export async function handleMarketplaceHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: MarketplaceHttpOptions,
): Promise<boolean> {
  // Use the shared endpoint helper for path matching, auth, and JSON parsing.
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: MARKETPLACE_PATH,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes: 1024 * 1024,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }

  // Resolve tenant context for billing.
  let tenant: import("./tenant-context.js").TenantContext | undefined;
  if (handled.authResult?.iamResult && handled.authResult.iamResult.ok) {
    tenant = resolveTenantContext({ iamResult: handled.authResult.iamResult }) ?? undefined;
  }
  if (!tenant) {
    sendJson(res, 403, { error: { message: "no tenant context", type: "auth_error" } });
    return true;
  }

  // Check buyer billing.
  const billingResult = await checkBillingAllowance({
    iamConfig: opts.iamConfig,
    tenant,
  });
  if (!billingResult.allowed) {
    sendJson(res, 402, {
      error: {
        message: billingResult.reason ?? "insufficient balance",
        type: "billing_error",
      },
    });
    return true;
  }

  const body =
    typeof handled.body === "object" && handled.body !== null
      ? (handled.body as Record<string, unknown>)
      : {};
  const model = typeof body.model === "string" ? body.model : "claude-sonnet-4-20250514";
  const stream = body.stream === true;
  const requestId = randomUUID();

  // Pick a seller.
  const seller = opts.scheduler.pickSeller();
  if (!seller) {
    res.setHeader("Retry-After", "30");
    sendJson(res, 503, {
      error: {
        message: "no marketplace sellers available — try again later",
        type: "marketplace_unavailable",
      },
    });
    return true;
  }

  // Reserve the seller.
  if (!opts.scheduler.reserveSeller(seller.nodeId)) {
    res.setHeader("Retry-After", "10");
    sendJson(res, 503, {
      error: { message: "seller became unavailable", type: "marketplace_unavailable" },
    });
    return true;
  }

  // Invoke marketplace.proxy on the seller node.
  const proxyParams = {
    requestId,
    model,
    messages: body.messages,
    stream,
    maxTokens: typeof body.max_tokens === "number" ? body.max_tokens : undefined,
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    system: typeof body.system === "string" ? body.system : undefined,
  };

  const invokeResult = await opts.nodeRegistry.invoke({
    nodeId: seller.nodeId,
    command: "marketplace.proxy",
    params: proxyParams,
    timeoutMs: PROXY_TIMEOUT_MS,
  });

  if (!invokeResult.ok) {
    opts.scheduler.releaseSeller(seller.nodeId, false);
    sendJson(res, 502, {
      error: {
        message: `marketplace proxy failed: ${invokeResult.error?.message ?? "unknown"}`,
        type: "proxy_error",
      },
    });
    return true;
  }

  // Listen for proxy events from the seller node via the event bus.
  if (stream) {
    await handleStreamingRelay(req, res, requestId, seller.nodeId, tenant, opts);
  } else {
    await handleNonStreamingRelay(req, res, requestId, seller.nodeId, tenant, opts);
  }

  return true;
}

/**
 * Relay streaming SSE chunks from seller node events to the buyer's HTTP response.
 */
async function handleStreamingRelay(
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
  sellerNodeId: string,
  tenant: { orgId: string; userId: string },
  opts: MarketplaceHttpOptions,
): Promise<void> {
  setSseHeaders(res);
  res.setHeader("X-Marketplace-Request-Id", requestId);

  await new Promise<void>((resolve) => {
    let completed = false;

    const timeout = setTimeout(() => {
      if (!completed) {
        completed = true;
        unsubscribe();
        writeDone(res);
        res.end();
        opts.scheduler.releaseSeller(sellerNodeId, false);
        resolve();
      }
    }, PROXY_TIMEOUT_MS);

    const cleanup = () => {
      if (!completed) {
        completed = true;
        unsubscribe();
        clearTimeout(timeout);
        opts.scheduler.releaseSeller(sellerNodeId, false);
        resolve();
      }
    };

    req.on("close", cleanup);

    const unsubscribe = marketplaceEventBus.onProxy(requestId, (evt: MarketplaceProxyEvent) => {
      if (completed) {
        return;
      }

      if (evt.kind === "chunk") {
        const data = typeof evt.payload.data === "string" ? evt.payload.data : "";
        if (data) {
          res.write(`data: ${data}\n\n`);
        }
      } else if (evt.kind === "done") {
        const done = evt.payload as unknown as MarketplaceProxyDonePayload;
        writeDone(res);
        res.end();
        clearTimeout(timeout);
        completed = true;
        unsubscribe();
        reportMarketplaceUsage(done, sellerNodeId, tenant, opts);
        opts.scheduler.releaseSeller(sellerNodeId, true, done.durationMs);
        resolve();
      } else if (evt.kind === "error") {
        res.write(`data: ${JSON.stringify({ error: evt.payload.message })}\n\n`);
        writeDone(res);
        res.end();
        clearTimeout(timeout);
        completed = true;
        unsubscribe();
        opts.scheduler.releaseSeller(sellerNodeId, false);
        resolve();
      }
    });
  });
}

/**
 * Wait for a complete non-streaming response from the seller node.
 */
async function handleNonStreamingRelay(
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
  sellerNodeId: string,
  tenant: { orgId: string; userId: string },
  opts: MarketplaceHttpOptions,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let completed = false;
    let responseSent = false;

    const timeout = setTimeout(() => {
      if (!completed) {
        completed = true;
        unsubscribe();
        if (!responseSent) {
          sendJson(res, 504, {
            error: { message: "marketplace proxy timeout", type: "timeout" },
          });
        }
        opts.scheduler.releaseSeller(sellerNodeId, false);
        resolve();
      }
    }, PROXY_TIMEOUT_MS);

    const cleanup = () => {
      if (!completed) {
        completed = true;
        unsubscribe();
        clearTimeout(timeout);
        opts.scheduler.releaseSeller(sellerNodeId, false);
        resolve();
      }
    };

    req.on("close", cleanup);

    const unsubscribe = marketplaceEventBus.onProxy(requestId, (evt: MarketplaceProxyEvent) => {
      if (completed) {
        return;
      }

      if (evt.kind === "chunk" && evt.payload.done === true) {
        // Non-streaming: the full response comes as a single chunk with done=true.
        const data = typeof evt.payload.data === "string" ? evt.payload.data : "{}";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(data);
        responseSent = true;
        // Don't resolve yet — wait for the "done" event for billing.
      } else if (evt.kind === "done") {
        const done = evt.payload as unknown as MarketplaceProxyDonePayload;
        clearTimeout(timeout);
        if (!responseSent) {
          sendJson(res, 200, { status: "completed" });
        }
        completed = true;
        unsubscribe();
        reportMarketplaceUsage(done, sellerNodeId, tenant, opts);
        opts.scheduler.releaseSeller(sellerNodeId, true, done.durationMs);
        resolve();
      } else if (evt.kind === "error") {
        clearTimeout(timeout);
        if (!responseSent) {
          sendJson(res, 502, {
            error: { message: String(evt.payload.message), type: "proxy_error" },
          });
        }
        completed = true;
        unsubscribe();
        opts.scheduler.releaseSeller(sellerNodeId, false);
        resolve();
      }
    });
  });
}

function reportMarketplaceUsage(
  done: MarketplaceProxyDonePayload,
  sellerNodeId: string,
  tenant: { orgId: string; userId: string },
  opts: MarketplaceHttpOptions,
): void {
  const pricing = calculateMarketplacePrice({
    model: done.model,
    inputTokens: done.inputTokens,
    outputTokens: done.outputTokens,
    config: opts.marketplaceConfig,
  });

  // Report buyer debit — charge the buyer's account.
  reportUsage({
    tenant: { orgId: tenant.orgId, userId: tenant.userId },
    model: done.model,
    provider: "marketplace",
    inputTokens: done.inputTokens,
    outputTokens: done.outputTokens,
    totalTokens: done.inputTokens + done.outputTokens,
    timestamp: Date.now(),
    nodeId: sellerNodeId,
  });

  // Report seller credit — credit the seller's earnings.
  // Seller is identified by nodeId; resolved to userId when available.
  const sellerSession = opts.nodeRegistry.get(sellerNodeId);
  const sellerUserId = sellerSession?.marketplacePayoutPreference ? sellerNodeId : sellerNodeId;
  reportUsage({
    tenant: { orgId: "marketplace", userId: sellerUserId },
    model: done.model,
    provider: "marketplace_seller",
    inputTokens: done.inputTokens,
    outputTokens: done.outputTokens,
    totalTokens: done.inputTokens + done.outputTokens,
    timestamp: Date.now(),
    nodeId: sellerNodeId,
  });

  // Log transaction for audit trail.
  const _tx: MarketplaceTransaction = {
    requestId: done.requestId,
    buyerUserId: tenant.userId,
    buyerOrgId: tenant.orgId,
    sellerNodeId,
    sellerUserId,
    model: done.model,
    inputTokens: done.inputTokens,
    outputTokens: done.outputTokens,
    buyerCostCents: pricing.buyerCostCents,
    sellerEarningsCents: pricing.sellerEarningsCents,
    platformFeeCents: pricing.platformFeeCents,
    aiTokenPayout: false,
    timestamp: Date.now(),
    durationMs: done.durationMs,
  };
}
