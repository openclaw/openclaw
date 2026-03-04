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
import type { GatewayIamConfig, MarketplaceConfig } from "../config/types.gateway.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { GatewayAuthResult, ResolvedGatewayAuth } from "./auth.js";
import type { MarketplaceProxyDonePayload } from "./marketplace/events.js";
import type { MarketplaceScheduler } from "./marketplace/scheduler.js";
import type { NodeRegistry } from "./node-registry.js";
import { validateIamToken } from "./auth-iam.js";
import { authorizeHttpGatewayConnect } from "./auth.js";
import { checkBillingAllowance } from "./billing/billing-gate.js";
import { reportUsage } from "./billing/usage-reporter.js";
import {
  sendJson,
  sendMethodNotAllowed,
  sendGatewayAuthFailure,
  readJsonBodyOrError,
  setSseHeaders,
  writeDone,
} from "./http-common.js";
import { getBearerToken } from "./http-utils.js";
import { calculateMarketplacePrice, type MarketplaceTransaction } from "./marketplace/billing.js";
import { marketplaceEventBus, type MarketplaceProxyEvent } from "./marketplace/event-bus.js";
import { resolveTenantContext } from "./tenant-context.js";

const MARKETPLACE_PATH = "/v1/marketplace/completions";
const MARKETPLACE_STATUS_PATH = "/v1/marketplace/status";
const PROXY_TIMEOUT_MS = 120_000;

/** When true, marketplace returns "coming soon" instead of processing requests. */
function isComingSoonMode(config: MarketplaceConfig): boolean {
  return config.comingSoon === true;
}

export type MarketplaceHttpOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
  iamConfig?: GatewayIamConfig;
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
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // GET /v1/marketplace/status — public status endpoint (no auth required).
  if (url.pathname === MARKETPLACE_STATUS_PATH && req.method === "GET") {
    const comingSoon = isComingSoonMode(opts.marketplaceConfig);
    sendJson(res, 200, {
      marketplace: {
        status: comingSoon ? "coming_soon" : "live",
        requestAccess: comingSoon ? "https://market.hanzo.bot/waitlist" : undefined,
        onChain: true,
        chain: { id: 36963, name: "Hanzo" },
        features: [
          "P2P compute sharing — earn from idle Claude capacity",
          "On-chain settlement via $AI token",
          "10% bonus for $AI token payouts",
        ],
      },
    });
    return true;
  }

  // Path matching.
  if (url.pathname !== MARKETPLACE_PATH) {
    return false;
  }

  // Method check.
  if (req.method !== "POST") {
    sendMethodNotAllowed(res);
    return true;
  }

  // Auth check.
  const rawToken = getBearerToken(req) ?? undefined;
  const authResult: GatewayAuthResult = await authorizeHttpGatewayConnect({
    auth: opts.auth,
    connectAuth: rawToken ? { token: rawToken, password: rawToken } : null,
    req,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
  if (!authResult.ok) {
    sendGatewayAuthFailure(res, authResult);
    return true;
  }

  // Read JSON body.
  const body = await readJsonBodyOrError(req, res, 1024 * 1024);
  if (body === undefined) {
    return true;
  }

  // Gate: marketplace coming soon mode — return waitlist info instead of processing.
  if (isComingSoonMode(opts.marketplaceConfig)) {
    sendJson(res, 503, {
      error: {
        message: "P2P Compute Marketplace is coming soon. Request early access at market.hanzo.bot",
        type: "marketplace_coming_soon",
      },
      requestAccess: "https://market.hanzo.bot/waitlist",
    });
    return true;
  }

  // Resolve tenant context for billing.
  // If IAM config is present and we have a bearer token, validate it to get IAM claims.
  let tenant: import("./tenant-context.js").TenantContext | undefined;
  if (opts.iamConfig && rawToken) {
    const iamResult = await validateIamToken(rawToken, opts.iamConfig);
    if (iamResult.ok) {
      tenant = resolveTenantContext({ iamResult }) ?? undefined;
    }
  }

  // Token-auth fallback: when auth succeeded via gateway token (not IAM JWT)
  // and billing gate is in warn/open mode, allow requests with a service tenant.
  // This supports internal testing and the TRY FREE flow.
  if (!tenant && authResult.method === "token") {
    const gateMode = process.env.BILLING_GATE_MODE;
    if (gateMode === "open" || gateMode === "warn") {
      tenant = { orgId: "hanzo", userId: "service-marketplace", userName: "z@hanzo.ai" };
    }
  }

  if (!tenant) {
    sendJson(res, 403, { error: { message: "no tenant context", type: "auth_error" } });
    return true;
  }

  // Check buyer billing.
  const billingResult = await checkBillingAllowance({
    iamConfig: opts.iamConfig,
    tenant,
    token: rawToken,
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

  const parsedBody =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const model =
    typeof parsedBody.model === "string" ? parsedBody.model : "claude-sonnet-4-20250514";
  const stream = parsedBody.stream === true;
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
    messages: parsedBody.messages,
    stream,
    maxTokens: typeof parsedBody.max_tokens === "number" ? parsedBody.max_tokens : undefined,
    temperature: typeof parsedBody.temperature === "number" ? parsedBody.temperature : undefined,
    system: typeof parsedBody.system === "string" ? parsedBody.system : undefined,
  };

  const invokeResult = await opts.nodeRegistry.invoke({
    nodeId: seller.nodeId,
    command: "marketplace.proxy",
    params: proxyParams,
    timeoutMs: PROXY_TIMEOUT_MS,
  });

  if (!invokeResult.ok) {
    opts.scheduler.getTrustManager()?.recordFailure(seller.nodeId);
    opts.scheduler.releaseSeller(seller.nodeId, false);
    const errCode = invokeResult.error?.code;
    const statusCode = errCode === "TIMEOUT" ? 504 : 502;
    const errorType =
      errCode === "UNAVAILABLE"
        ? "seller_unavailable"
        : errCode === "TIMEOUT"
          ? "seller_timeout"
          : "proxy_error";
    sendJson(res, statusCode, {
      error: {
        message: invokeResult.error?.message ?? "marketplace proxy failed",
        type: errorType,
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
  res.setHeader("X-Marketplace-Request-Id", requestId);
  setSseHeaders(res);

  await new Promise<void>((resolve) => {
    let completed = false;

    const trust = opts.scheduler.getTrustManager();

    const timeout = setTimeout(() => {
      if (!completed) {
        completed = true;
        unsubscribe();
        writeDone(res);
        res.end();
        trust?.recordFailure(sellerNodeId);
        opts.scheduler.releaseSeller(sellerNodeId, false);
        resolve();
      }
    }, PROXY_TIMEOUT_MS);

    const cleanup = () => {
      if (!completed) {
        completed = true;
        unsubscribe();
        clearTimeout(timeout);
        trust?.recordFailure(sellerNodeId);
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
        trust?.recordSuccess(sellerNodeId, done.durationMs, done.inputTokens, done.outputTokens);
        reportMarketplaceUsage(done, sellerNodeId, tenant, opts);
        opts.scheduler.releaseSeller(sellerNodeId, true, done.durationMs);
        resolve();
      } else if (evt.kind === "error") {
        const errorEvent = {
          error: {
            type: "server_error",
            message: typeof evt.payload.message === "string" ? evt.payload.message : "proxy error",
          },
        };
        res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
        writeDone(res);
        res.end();
        clearTimeout(timeout);
        completed = true;
        unsubscribe();
        trust?.recordFailure(sellerNodeId);
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
    const trust = opts.scheduler.getTrustManager();

    const timeout = setTimeout(() => {
      if (!completed) {
        completed = true;
        unsubscribe();
        if (!responseSent) {
          sendJson(res, 504, {
            error: { message: "marketplace proxy timeout", type: "timeout" },
          });
        }
        trust?.recordFailure(sellerNodeId);
        opts.scheduler.releaseSeller(sellerNodeId, false);
        resolve();
      }
    }, PROXY_TIMEOUT_MS);

    const cleanup = () => {
      if (!completed) {
        completed = true;
        unsubscribe();
        clearTimeout(timeout);
        trust?.recordFailure(sellerNodeId);
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
        // Don't resolve yet -- wait for the "done" event for billing.
      } else if (evt.kind === "done") {
        const done = evt.payload as unknown as MarketplaceProxyDonePayload;
        clearTimeout(timeout);
        if (!responseSent) {
          sendJson(res, 200, { status: "completed" });
        }
        completed = true;
        unsubscribe();
        trust?.recordSuccess(sellerNodeId, done.durationMs, done.inputTokens, done.outputTokens);
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
        trust?.recordFailure(sellerNodeId);
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

  // Report buyer debit — charge the buyer's account at marketplace price.
  reportUsage({
    tenant: { orgId: tenant.orgId, userId: tenant.userId },
    model: done.model,
    provider: "marketplace",
    inputTokens: done.inputTokens,
    outputTokens: done.outputTokens,
    totalTokens: done.inputTokens + done.outputTokens,
    timestamp: Date.now(),
    nodeId: sellerNodeId,
    amountCents: pricing.buyerCostCents,
  });

  // Resolve seller identity from node session (nodeId is the primary identifier).
  const sellerSession = opts.nodeRegistry.get(sellerNodeId);
  const sellerUserId = sellerNodeId;
  const sellerPayoutPref = sellerSession?.marketplacePayoutPreference ?? "usd";

  // Deposit seller earnings into their Hanzo Commerce wallet.
  void depositSellerEarnings(sellerUserId, sellerNodeId, pricing.sellerEarningsCents, done).catch(
    (err) =>
      // eslint-disable-next-line no-console
      console.error(
        `[marketplace] CRITICAL: Failed to deposit seller earnings for ${sellerNodeId}: ${err instanceof Error ? err.message : String(err)}`,
      ),
  );

  // Log transaction for audit trail.
  const tx: MarketplaceTransaction = {
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
    aiTokenPayout: sellerPayoutPref === "ai_token",
    timestamp: Date.now(),
    durationMs: done.durationMs,
  };
  transactionLog.push(tx);
  if (transactionLog.length > MAX_TX_LOG) {
    transactionLog.splice(0, transactionLog.length - MAX_TX_LOG);
  }

  // Persist transaction to Commerce API (fire-and-forget; in-memory is the hot cache).
  void persistTransaction(tx).catch((err) =>
    console.error(
      `[marketplace] Failed to persist transaction ${tx.requestId}: ${err instanceof Error ? err.message : String(err)}`,
    ),
  );
}

/** In-memory transaction log for audit trail and payout aggregation. */
const transactionLog: MarketplaceTransaction[] = [];
const MAX_TX_LOG = 10_000;

/** Read the in-memory transaction log (hot cache; Commerce API is source of truth). */
export function getTransactionLog(): readonly MarketplaceTransaction[] {
  return transactionLog;
}

/**
 * Persist a marketplace transaction to Commerce API for durable storage.
 * Commerce is the source of truth; the in-memory log is a hot cache only.
 */
export async function persistTransaction(tx: MarketplaceTransaction): Promise<void> {
  const baseUrl = getCommerceBaseUrl();
  const headers = getCommerceHeaders();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${baseUrl}/api/v1/marketplace/transactions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: tx.requestId,
        buyerUserId: tx.buyerUserId,
        buyerOrgId: tx.buyerOrgId,
        sellerNodeId: tx.sellerNodeId,
        sellerUserId: tx.sellerUserId,
        model: tx.model,
        inputTokens: tx.inputTokens,
        outputTokens: tx.outputTokens,
        buyerCostCents: tx.buyerCostCents,
        sellerEarningsCents: tx.sellerEarningsCents,
        platformFeeCents: tx.platformFeeCents,
        aiTokenPayout: tx.aiTokenPayout,
        timestamp: tx.timestamp,
        durationMs: tx.durationMs,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Commerce API ${response.status}: ${errText.substring(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch recent transactions from Commerce API (source of truth).
 * Used by the marketplace.transactions WS method and payout processing.
 * Falls back to empty array on failure (Commerce unavailable at startup is acceptable).
 */
export async function fetchTransactionsFromCommerce(
  limit = 1000,
): Promise<MarketplaceTransaction[]> {
  const baseUrl = getCommerceBaseUrl();
  const headers = getCommerceHeaders();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${baseUrl}/api/v1/marketplace/transactions?limit=${limit}`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`[marketplace] Failed to fetch transactions from Commerce: ${response.status}`);
      return [];
    }

    const data = (await response.json()) as { transactions?: MarketplaceTransaction[] };
    return data.transactions ?? [];
  } catch (err) {
    console.warn(
      `[marketplace] Failed to fetch transactions from Commerce: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function getCommerceBaseUrl(): string {
  return (process.env.COMMERCE_API_URL ?? "http://commerce.hanzo.svc.cluster.local:8001").replace(
    /\/+$/,
    "",
  );
}

function getCommerceHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (process.env.COMMERCE_SERVICE_TOKEN) {
    headers.Authorization = `Bearer ${process.env.COMMERCE_SERVICE_TOKEN}`;
  }
  return headers;
}

/** Deposit seller earnings into their Commerce wallet via billing/deposit. */
async function depositSellerEarnings(
  sellerUserId: string,
  sellerNodeId: string,
  amountCents: number,
  done: MarketplaceProxyDonePayload,
): Promise<void> {
  if (amountCents <= 0) {
    return;
  }
  const baseUrl = (
    process.env.COMMERCE_API_URL ?? "http://commerce.hanzo.svc.cluster.local:8001"
  ).replace(/\/+$/, "");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (process.env.COMMERCE_SERVICE_TOKEN) {
    headers.Authorization = `Bearer ${process.env.COMMERCE_SERVICE_TOKEN}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    await fetch(`${baseUrl}/api/v1/billing/deposit`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        user: sellerUserId,
        currency: "usd",
        amount: amountCents,
        notes: `Marketplace earnings: ${done.model} (${done.inputTokens + done.outputTokens} tokens)`,
        tags: "marketplace-earning",
      }),
      signal: controller.signal,
    });
  } catch (err) {
    console.warn(
      `[marketplace] Failed to deposit seller earnings for ${sellerNodeId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
