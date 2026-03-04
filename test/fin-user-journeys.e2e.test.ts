/**
 * E2E user journey tests for the fin-core financial dashboard.
 *
 * Unlike the existing HTML/CSS/data-injection tests, these tests cover
 * **interactive user journeys** with a stateful mock server:
 *
 *  Part A: API Lifecycle Chains (no browser needed)
 *   1. Order → auto tier → immediate execution
 *   2. Order → confirm tier → pending approval → approve → executed
 *   3. Order → reject tier → blocked
 *   4. Approval flow: approve / reject / error cases
 *   5. Emergency stop → trading disabled
 *   6. Risk evaluation → 3-tier response
 *   7. SSE event streaming
 *
 *  Part B: Browser User Journeys (Playwright)
 *   8. Morning routine — overview dashboard data verification
 *   9. Navigation chain — 4 pages + legacy redirects
 *  10. Trading desk — positions, orders, pending events
 *  11. Strategy arena — pipeline counts, promotion gates
 *  12. Emergency stop button — UI confirmation
 *
 * Run:
 *   pnpm vitest run test/fin-user-journeys.e2e.test.ts --config vitest.e2e.config.ts
 *   OPENCLAW_E2E_VERBOSE=1 pnpm vitest run test/fin-user-journeys.e2e.test.ts --config vitest.e2e.config.ts
 */

import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  chromium,
  browserPath,
  hasBrowser,
  getFreePort,
  stripChartJsCdn,
} from "./helpers/e2e-browser.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Paths ──

const DASHBOARD_DIR = join(__dirname, "../extensions/fin-core/dashboard");
const hasOverviewHtml = existsSync(join(DASHBOARD_DIR, "overview.html"));

// ══════════════════════════════════════════════════════════════════
//  STATEFUL MOCK SERVER
//  Faithfully implements fin-core route-handler business logic
//  for API lifecycle testing.
// ══════════════════════════════════════════════════════════════════

type MockEvent = {
  id: string;
  type: string;
  title: string;
  detail: string;
  status: "pending" | "approved" | "rejected" | "completed";
  timestamp: string;
  actionParams?: Record<string, unknown>;
};

type MockRiskConfig = {
  enabled: boolean;
  maxAutoTradeUsd: number;
  confirmThresholdUsd: number;
  maxDailyLossUsd: number;
  maxPositionPct: number;
  maxLeverage: number;
  allowedPairs: string[];
  blockedPairs: string[];
};

const DEFAULT_RISK_CONFIG: MockRiskConfig = {
  enabled: true,
  maxAutoTradeUsd: 100,
  confirmThresholdUsd: 500,
  maxDailyLossUsd: 1000,
  maxPositionPct: 25,
  maxLeverage: 1,
  allowedPairs: [],
  blockedPairs: [],
};

const MOCK_POSITIONS = [
  {
    symbol: "BTC/USDT",
    side: "long",
    quantity: 0.5,
    entryPrice: 65000,
    currentPrice: 67500,
    unrealizedPnl: 1250,
  },
  {
    symbol: "ETH/USDT",
    side: "short",
    quantity: 5.0,
    entryPrice: 3200,
    currentPrice: 3150,
    unrealizedPnl: 250,
  },
];

const MOCK_STRATEGIES = [
  {
    id: "s-alpha",
    name: "Alpha Momentum",
    level: "L3",
    totalReturn: 12.5,
    sharpe: 2.1,
    maxDrawdown: -8.5,
    totalTrades: 156,
    status: "running",
  },
  {
    id: "s-beta",
    name: "Beta Mean Reversion",
    level: "L2",
    totalReturn: 5.8,
    sharpe: 1.4,
    maxDrawdown: -12.3,
    totalTrades: 89,
    status: "running",
  },
  {
    id: "s-gamma",
    name: "Gamma Breakout",
    level: "L1",
    totalReturn: 3.2,
    sharpe: 0.9,
    maxDrawdown: -18.1,
    totalTrades: 42,
    status: "running",
  },
  {
    id: "s-delta",
    name: "Delta Scalper",
    level: "L0",
    totalReturn: 0,
    sharpe: 0,
    maxDrawdown: 0,
    totalTrades: 0,
    status: "incubating",
  },
];

/** Stateful mock server that implements fin-core API + dashboard routes. */
function createMockServer(opts?: { riskConfig?: Partial<MockRiskConfig> }) {
  let events: MockEvent[] = [];
  let riskConfig: MockRiskConfig = { ...DEFAULT_RISK_CONFIG, ...opts?.riskConfig };
  let eventCounter = 0;
  const sseClients: http.ServerResponse[] = [];

  // -- State helpers --

  function addEvent(ev: Omit<MockEvent, "id" | "timestamp">): MockEvent {
    eventCounter++;
    const event: MockEvent = {
      ...ev,
      id: `evt-${eventCounter}`,
      timestamp: new Date().toISOString(),
    };
    events.push(event);
    // Push to SSE clients
    for (const client of sseClients) {
      try {
        client.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // client disconnected
      }
    }
    return event;
  }

  function reset() {
    events = [];
    eventCounter = 0;
    riskConfig = { ...DEFAULT_RISK_CONFIG, ...opts?.riskConfig };
  }

  // -- Dashboard templates --

  let sharedCss = "";
  const templates: Record<string, { html: string; css: string }> = {};

  try {
    sharedCss = readFileSync(join(DASHBOARD_DIR, "unified-dashboard.css"), "utf-8");
  } catch {
    /* ok */
  }
  for (const page of ["overview", "trading-desk", "strategy-arena", "strategy-lab"]) {
    try {
      templates[page] = {
        html: readFileSync(join(DASHBOARD_DIR, `${page}.html`), "utf-8"),
        css: readFileSync(join(DASHBOARD_DIR, `${page}.css`), "utf-8"),
      };
    } catch {
      templates[page] = { html: "", css: "" };
    }
  }

  function renderPage(page: string, data: unknown): string | null {
    const t = templates[page];
    if (!t?.html || !sharedCss) {
      return null;
    }
    const safeJson = JSON.stringify(data).replace(/<\//g, "<\\/");
    return stripChartJsCdn(
      t.html
        .replace("/*__SHARED_CSS__*/", sharedCss)
        .replace("/*__PAGE_CSS__*/", t.css || "")
        .replace(/\/\*__PAGE_DATA__\*\/\s*\{\}/, safeJson),
    );
  }

  // -- Data gathering (mirrors data-gathering.ts) --

  function buildOverviewData() {
    return {
      trading: {
        summary: {
          totalEquity: 125430,
          dailyPnl: 2890,
          dailyPnlPct: 2.3,
          positionCount: MOCK_POSITIONS.length,
          strategyCount: MOCK_STRATEGIES.length,
          winRate: 0.68,
          avgSharpe: 1.2,
        },
        positions: MOCK_POSITIONS,
        orders: [],
        snapshots: [],
        strategies: MOCK_STRATEGIES,
        backtests: [],
        allocations: { items: [], totalAllocated: 0, cashReserve: 0, totalCapital: 125430 },
      },
      events: { events, pendingCount: events.filter((e) => e.status === "pending").length },
      alerts: [],
      risk: {
        enabled: riskConfig.enabled,
        maxAutoTradeUsd: riskConfig.maxAutoTradeUsd,
        confirmThresholdUsd: riskConfig.confirmThresholdUsd,
        maxDailyLossUsd: riskConfig.maxDailyLossUsd,
      },
      fund: { allocations: [], totalCapital: 125430 },
      config: {
        generatedAt: new Date().toISOString(),
        exchanges: [{ id: "binance-test", exchange: "binance", testnet: true }],
        trading: riskConfig,
        plugins: { total: 12, enabled: 10, entries: [{ id: "fin-core", enabled: true }] },
      },
    };
  }

  function buildArenaData() {
    const data = buildOverviewData();
    const strategies = MOCK_STRATEGIES;
    return {
      ...data,
      pipeline: {
        l0: strategies.filter((s) => s.level === "L0" || s.level === "INCUBATE").length,
        l1: strategies.filter((s) => s.level === "L1" || s.level === "BACKTEST").length,
        l2: strategies.filter((s) => s.level === "L2" || s.level === "PAPER").length,
        l3: strategies.filter((s) => s.level === "L3" || s.level === "LIVE").length,
      },
      gates: {
        l0ToL1: { auto: true, label: "Auto after creation" },
        l1ToL2: { sharpeMin: 1.0, maxDdMax: -15, label: "Sharpe > 1.0, MaxDD < -15%" },
        l2ToL3: {
          paperDays: 14,
          sharpeMin: 1.2,
          requiresApproval: true,
          label: "14d paper, Sharpe > 1.2, requires approval",
        },
      },
    };
  }

  // -- HTTP handler --

  function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
        } catch {
          resolve({});
        }
      });
    });
  }

  function json(res: http.ServerResponse, status: number, data: unknown) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  function html(res: http.ServerResponse, content: string) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(content);
  }

  function redirect(res: http.ServerResponse, to: string) {
    res.writeHead(302, { Location: to });
    res.end();
  }

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    // ── Dashboard pages ──
    if (method === "GET" && url === "/dashboard/overview") {
      const page = renderPage("overview", buildOverviewData());
      return page ? html(res, page) : json(res, 200, buildOverviewData());
    }
    if (method === "GET" && url === "/dashboard/trading-desk") {
      const data = buildOverviewData();
      const page = renderPage("trading-desk", data);
      return page ? html(res, page) : json(res, 200, data);
    }
    if (method === "GET" && url === "/dashboard/strategy-arena") {
      const data = buildArenaData();
      const page = renderPage("strategy-arena", data);
      return page ? html(res, page) : json(res, 200, data);
    }
    if (method === "GET" && url === "/dashboard/strategy-lab") {
      const data = {
        strategies: MOCK_STRATEGIES,
        backtests: [],
        allocations: { items: [], totalAllocated: 0, cashReserve: 0, totalCapital: 125430 },
        fund: { allocations: [], totalCapital: 125430 },
        summary: buildOverviewData().trading.summary,
      };
      const page = renderPage("strategy-lab", data);
      return page ? html(res, page) : json(res, 200, data);
    }

    // ── Legacy redirects ──
    if (method === "GET" && url === "/dashboard/finance") {
      return redirect(res, "/dashboard/overview");
    }
    if (method === "GET" && url === "/dashboard/trading") {
      return redirect(res, "/dashboard/trading-desk");
    }
    if (method === "GET" && url === "/dashboard/command-center") {
      return redirect(res, "/dashboard/trading-desk");
    }
    if (method === "GET" && url === "/dashboard/mission-control") {
      return redirect(res, "/dashboard/overview");
    }
    if (method === "GET" && url === "/dashboard/evolution") {
      return redirect(res, "/dashboard/strategy-arena");
    }
    if (method === "GET" && url === "/dashboard/fund") {
      return redirect(res, "/dashboard/strategy-lab");
    }
    if (method === "GET" && url === "/dashboard/strategy") {
      return redirect(res, "/dashboard/strategy-arena");
    }
    if (method === "GET" && url === "/dashboard/arena") {
      return redirect(res, "/dashboard/strategy-arena");
    }

    // ── JSON API ──
    if (method === "GET" && url === "/api/v1/finance/config") {
      return json(res, 200, buildOverviewData().config);
    }
    if (method === "GET" && url === "/api/v1/finance/exchange-health") {
      return json(res, 200, {
        exchanges: [
          {
            exchangeId: "binance-test",
            connected: true,
            lastPingMs: 42,
            apiCallsToday: 156,
            apiLimit: 1200,
          },
        ],
      });
    }
    if (method === "GET" && url === "/api/v1/finance/events") {
      return json(res, 200, {
        events,
        pendingCount: events.filter((e) => e.status === "pending").length,
      });
    }
    if (method === "GET" && url === "/api/v1/finance/strategy-arena") {
      return json(res, 200, buildArenaData());
    }

    // ── SSE stream ──
    if (method === "GET" && url === "/api/v1/finance/events/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      sseClients.push(res);
      req.on("close", () => {
        const idx = sseClients.indexOf(res);
        if (idx >= 0) {
          sseClients.splice(idx, 1);
        }
      });
      return;
    }

    // ── Risk Evaluate ──
    if (method === "POST" && url === "/api/v1/finance/risk/evaluate") {
      const body = await parseBody(req);
      const estimatedUsd = (body.estimatedValueUsd as number) ?? 0;

      if (!riskConfig.enabled) {
        return json(res, 200, { tier: "reject", reason: "Trading is disabled" });
      }

      // Blocked pairs
      if (
        riskConfig.blockedPairs.length > 0 &&
        riskConfig.blockedPairs.includes(body.symbol as string)
      ) {
        return json(res, 200, { tier: "reject", reason: `${body.symbol as string} is blocked` });
      }

      if (estimatedUsd <= riskConfig.maxAutoTradeUsd) {
        return json(res, 200, { tier: "auto", reason: `$${estimatedUsd} within auto limit` });
      }
      if (estimatedUsd <= riskConfig.confirmThresholdUsd) {
        return json(res, 200, {
          tier: "confirm",
          reason: `$${estimatedUsd} requires confirmation`,
        });
      }
      return json(res, 200, {
        tier: "reject",
        reason: `$${estimatedUsd} exceeds maximum threshold`,
      });
    }

    // ── Place Order ──
    if (method === "POST" && url === "/api/v1/finance/orders") {
      const body = await parseBody(req);
      const { symbol, side, quantity, currentPrice } = body;

      if (!symbol || !side || !quantity) {
        return json(res, 400, { error: "Missing required fields: symbol, side, quantity" });
      }

      if (!riskConfig.enabled) {
        return json(res, 403, { error: "Trading is disabled" });
      }

      const estimatedUsd = ((currentPrice as number) ?? 0) * ((quantity as number) ?? 0);

      // Risk evaluation
      if (estimatedUsd > riskConfig.confirmThresholdUsd) {
        return json(res, 403, { error: "Order rejected by risk controller" });
      }

      if (estimatedUsd > riskConfig.maxAutoTradeUsd) {
        const event = addEvent({
          type: "trade_pending",
          title: `${(side as string).toUpperCase()} ${quantity as string} ${symbol as string}`,
          detail: `$${estimatedUsd.toFixed(0)} requires user confirmation`,
          status: "pending",
          actionParams: { symbol, side, quantity, currentPrice },
        });
        return json(res, 202, {
          status: "pending_approval",
          eventId: event.id,
          reason: `$${estimatedUsd.toFixed(0)} exceeds auto-trade limit`,
        });
      }

      // Auto-execute
      addEvent({
        type: "trade_executed",
        title: `${(side as string).toUpperCase()} ${quantity as string} ${symbol as string}`,
        detail: `Auto-executed at $${currentPrice as number}`,
        status: "completed",
      });

      return json(res, 201, {
        id: `ord-${Date.now()}`,
        symbol,
        side,
        quantity,
        fillPrice: currentPrice,
        status: "filled",
      });
    }

    // ── Cancel Order ──
    if (method === "POST" && url === "/api/v1/finance/orders/cancel") {
      const body = await parseBody(req);
      if (!body.orderId) {
        return json(res, 400, { error: "Missing required field: orderId" });
      }
      addEvent({
        type: "order_cancelled",
        title: `Cancel order ${body.orderId as string}`,
        detail: "Order cancellation requested",
        status: "completed",
      });
      return json(res, 200, { status: "cancelled", orderId: body.orderId });
    }

    // ── Approve / Reject Event ──
    if (method === "POST" && url === "/api/v1/finance/events/approve") {
      const body = await parseBody(req);
      const {
        id,
        action: reqAction,
        reason,
      } = body as {
        id?: string;
        action?: string;
        reason?: string;
      };

      if (!id) {
        return json(res, 400, { error: "Missing required field: id" });
      }

      const event = events.find((e) => e.id === id);
      if (!event) {
        return json(res, 404, { error: `Event ${id} not found` });
      }
      if (event.status !== "pending") {
        return json(res, 404, { error: `Event ${id} is not pending (status: ${event.status})` });
      }

      if (reqAction === "reject") {
        event.status = "rejected";
        return json(res, 200, { status: "rejected", eventId: id, reason });
      }

      // Approve → execute
      event.status = "approved";
      addEvent({
        type: "trade_executed",
        title: event.title,
        detail: `Approved and executed`,
        status: "completed",
      });
      return json(res, 200, { status: "approved", eventId: id });
    }

    // ── Emergency Stop ──
    if (method === "POST" && url === "/api/v1/finance/emergency-stop") {
      riskConfig.enabled = false;
      const pausedStrategies = MOCK_STRATEGIES.filter(
        (s) => s.status !== "stopped" && s.status !== "paused",
      ).map((s) => s.id);

      addEvent({
        type: "emergency_stop",
        title: "EMERGENCY STOP ACTIVATED",
        detail: `Trading disabled. ${pausedStrategies.length} strategies paused.`,
        status: "completed",
      });

      return json(res, 200, {
        status: "stopped",
        tradingDisabled: true,
        strategiesPaused: pausedStrategies,
        message: "Emergency stop activated. All trading disabled.",
      });
    }

    // ── 404 fallback ──
    json(res, 404, { error: "Not found" });
  });

  return { server, reset, addEvent, getEvents: () => events, getRiskConfig: () => riskConfig };
}

// ── HTTP helper ──

function fetchUrl(
  baseUrl: string,
  path: string,
  opts?: { method?: string; body?: unknown; followRedirects?: boolean },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: unknown; raw: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(path, baseUrl);
    const payload = opts?.body ? JSON.stringify(opts.body) : undefined;

    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method: opts?.method ?? "GET",
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        // Follow redirects if asked
        if (
          opts?.followRedirects &&
          (res.statusCode === 301 || res.statusCode === 302) &&
          res.headers.location
        ) {
          fetchUrl(baseUrl, res.headers.location, opts).then(resolve, reject);
          return;
        }

        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let body: unknown = data;
          try {
            body = JSON.parse(data);
          } catch {
            /* raw text */
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, raw: data });
        });
      },
    );
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════
//  PART A: API LIFECYCLE CHAINS
//  No browser needed — pure HTTP request chains testing full
//  order-to-execution lifecycle.
// ══════════════════════════════════════════════════════════════════

describe("Part A: API Lifecycle Chains", () => {
  let port: number;
  let baseUrl: string;
  const mock = createMockServer();

  beforeAll(async () => {
    port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    await new Promise<void>((resolve) => mock.server.listen(port, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  });

  beforeEach(() => {
    mock.reset();
  });

  // ── Scenario 1: Small Order → Auto Execution ──

  describe("Scenario 1: Order auto-execution (≤$100)", () => {
    it("places small order → 201 filled → event created", async () => {
      const res = await fetchUrl(baseUrl, "/api/v1/finance/orders", {
        method: "POST",
        body: { symbol: "BTC/USDT", side: "buy", quantity: 0.001, currentPrice: 65000 },
      });

      // $65 is within auto tier ($100)
      expect(res.status).toBe(201);
      const body = res.body as Record<string, unknown>;
      expect(body.status).toBe("filled");
      expect(body.symbol).toBe("BTC/USDT");
      expect(body.fillPrice).toBe(65000);

      // Verify event was created
      const evRes = await fetchUrl(baseUrl, "/api/v1/finance/events");
      const evBody = evRes.body as { events: MockEvent[]; pendingCount: number };
      expect(evBody.events).toHaveLength(1);
      expect(evBody.events[0].type).toBe("trade_executed");
      expect(evBody.events[0].status).toBe("completed");
      expect(evBody.pendingCount).toBe(0);
    });
  });

  // ── Scenario 2: Medium Order → Confirm Tier → Approve → Execute ──

  describe("Scenario 2: Order confirm tier → approve → execute", () => {
    it("places medium order → 202 pending → approve → event chain", async () => {
      // Step 1: Place order ($200 — exceeds $100 auto, within $500 confirm)
      const orderRes = await fetchUrl(baseUrl, "/api/v1/finance/orders", {
        method: "POST",
        body: { symbol: "ETH/USDT", side: "buy", quantity: 0.1, currentPrice: 2000 },
      });

      expect(orderRes.status).toBe(202);
      const orderBody = orderRes.body as { status: string; eventId: string; reason: string };
      expect(orderBody.status).toBe("pending_approval");
      expect(orderBody.eventId).toBeDefined();
      expect(orderBody.reason).toContain("200");

      // Step 2: Verify pending event exists
      const evRes = await fetchUrl(baseUrl, "/api/v1/finance/events");
      const evBody = evRes.body as { events: MockEvent[]; pendingCount: number };
      expect(evBody.events).toHaveLength(1);
      expect(evBody.events[0].status).toBe("pending");
      expect(evBody.events[0].type).toBe("trade_pending");
      expect(evBody.pendingCount).toBe(1);

      // Step 3: Approve the event
      const approveRes = await fetchUrl(baseUrl, "/api/v1/finance/events/approve", {
        method: "POST",
        body: { id: orderBody.eventId, action: "approve" },
      });

      expect(approveRes.status).toBe(200);
      expect((approveRes.body as Record<string, unknown>).status).toBe("approved");

      // Step 4: Verify execution event was also created
      const finalEvRes = await fetchUrl(baseUrl, "/api/v1/finance/events");
      const finalBody = finalEvRes.body as { events: MockEvent[]; pendingCount: number };
      expect(finalBody.events).toHaveLength(2); // pending (now approved) + executed
      expect(finalBody.events[0].status).toBe("approved");
      expect(finalBody.events[1].type).toBe("trade_executed");
      expect(finalBody.pendingCount).toBe(0);
    });
  });

  // ── Scenario 3: Large Order → Reject Tier ──

  describe("Scenario 3: Order rejection (>$500 threshold)", () => {
    it("rejects orders exceeding confirm threshold", async () => {
      const res = await fetchUrl(baseUrl, "/api/v1/finance/orders", {
        method: "POST",
        body: { symbol: "BTC/USDT", side: "buy", quantity: 0.1, currentPrice: 65000 },
      });

      // $6500 exceeds $500 confirm threshold
      expect(res.status).toBe(403);
      expect((res.body as Record<string, unknown>).error).toContain("rejected");

      // No events should be created
      const evRes = await fetchUrl(baseUrl, "/api/v1/finance/events");
      expect((evRes.body as { events: unknown[] }).events).toHaveLength(0);
    });
  });

  // ── Scenario 4: Approval Flow Edge Cases ──

  describe("Scenario 4: Approval flow edge cases", () => {
    it("rejects non-existent event", async () => {
      const res = await fetchUrl(baseUrl, "/api/v1/finance/events/approve", {
        method: "POST",
        body: { id: "evt-nonexistent", action: "approve" },
      });
      expect(res.status).toBe(404);
      expect((res.body as Record<string, unknown>).error).toContain("not found");
    });

    it("rejects already-approved event", async () => {
      // Create and approve an event first
      const orderRes = await fetchUrl(baseUrl, "/api/v1/finance/orders", {
        method: "POST",
        body: { symbol: "SOL/USDT", side: "buy", quantity: 1, currentPrice: 200 },
      });
      const eventId = (orderRes.body as { eventId: string }).eventId;

      await fetchUrl(baseUrl, "/api/v1/finance/events/approve", {
        method: "POST",
        body: { id: eventId, action: "approve" },
      });

      // Try approving again
      const res = await fetchUrl(baseUrl, "/api/v1/finance/events/approve", {
        method: "POST",
        body: { id: eventId, action: "approve" },
      });
      expect(res.status).toBe(404);
      expect((res.body as Record<string, unknown>).error).toContain("not pending");
    });

    it("rejects a pending event with reason", async () => {
      const orderRes = await fetchUrl(baseUrl, "/api/v1/finance/orders", {
        method: "POST",
        body: { symbol: "BNB/USDT", side: "buy", quantity: 1, currentPrice: 300 },
      });
      const eventId = (orderRes.body as { eventId: string }).eventId;

      const res = await fetchUrl(baseUrl, "/api/v1/finance/events/approve", {
        method: "POST",
        body: { id: eventId, action: "reject", reason: "Too risky right now" },
      });
      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).status).toBe("rejected");

      // Verify event status
      const evRes = await fetchUrl(baseUrl, "/api/v1/finance/events");
      expect((evRes.body as { events: MockEvent[] }).events[0].status).toBe("rejected");
    });

    it("returns 400 without event id", async () => {
      const res = await fetchUrl(baseUrl, "/api/v1/finance/events/approve", {
        method: "POST",
        body: { action: "approve" },
      });
      expect(res.status).toBe(400);
    });
  });

  // ── Scenario 5: Emergency Stop ──

  describe("Scenario 5: Emergency stop", () => {
    it("disables trading and pauses all strategies", async () => {
      const res = await fetchUrl(baseUrl, "/api/v1/finance/emergency-stop", { method: "POST" });

      expect(res.status).toBe(200);
      const body = res.body as {
        status: string;
        tradingDisabled: boolean;
        strategiesPaused: string[];
        message: string;
      };
      expect(body.status).toBe("stopped");
      expect(body.tradingDisabled).toBe(true);
      expect(body.strategiesPaused.length).toBeGreaterThan(0);
      expect(body.message).toContain("Emergency stop");

      // Verify event was created
      const evRes = await fetchUrl(baseUrl, "/api/v1/finance/events");
      const events = (evRes.body as { events: MockEvent[] }).events;
      expect(events.some((e) => e.type === "emergency_stop")).toBe(true);

      // Verify subsequent orders are blocked
      const orderRes = await fetchUrl(baseUrl, "/api/v1/finance/orders", {
        method: "POST",
        body: { symbol: "BTC/USDT", side: "buy", quantity: 0.001, currentPrice: 65000 },
      });
      expect(orderRes.status).toBe(403);
      expect((orderRes.body as Record<string, unknown>).error).toContain("disabled");
    });
  });

  // ── Scenario 6: Risk Evaluation 3-Tier ──

  describe("Scenario 6: Risk evaluation — 3 tiers", () => {
    it("auto tier for small amounts", async () => {
      const res = await fetchUrl(baseUrl, "/api/v1/finance/risk/evaluate", {
        method: "POST",
        body: { symbol: "BTC/USDT", side: "buy", amount: 0.001, estimatedValueUsd: 50 },
      });
      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).tier).toBe("auto");
    });

    it("confirm tier for medium amounts", async () => {
      const res = await fetchUrl(baseUrl, "/api/v1/finance/risk/evaluate", {
        method: "POST",
        body: { symbol: "ETH/USDT", side: "buy", amount: 0.1, estimatedValueUsd: 300 },
      });
      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).tier).toBe("confirm");
    });

    it("reject tier for large amounts", async () => {
      const res = await fetchUrl(baseUrl, "/api/v1/finance/risk/evaluate", {
        method: "POST",
        body: { symbol: "BTC/USDT", side: "buy", amount: 1, estimatedValueUsd: 65000 },
      });
      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).tier).toBe("reject");
    });

    it("reject blocked pairs", async () => {
      // Reset with blocked pair config
      mock.reset();
      mock.getRiskConfig().blockedPairs = ["DOGE/USDT"];

      const res = await fetchUrl(baseUrl, "/api/v1/finance/risk/evaluate", {
        method: "POST",
        body: { symbol: "DOGE/USDT", side: "buy", amount: 100, estimatedValueUsd: 10 },
      });
      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).tier).toBe("reject");
      expect((res.body as Record<string, unknown>).reason).toContain("blocked");
    });
  });

  // ── Scenario 7: SSE Event Stream ──

  describe("Scenario 7: SSE real-time event stream", () => {
    it("pushes events to SSE clients in real-time", async () => {
      const receivedEvents: string[] = [];

      // Connect SSE client
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`${baseUrl}/api/v1/finance/events/stream`, (res) => {
          expect(res.headers["content-type"]).toBe("text/event-stream");

          res.setEncoding("utf8");
          let buffer = "";

          res.on("data", (chunk: string) => {
            buffer += chunk;
            // Parse SSE messages
            const messages = buffer.split("\n\n");
            buffer = messages.pop()!; // Keep incomplete message in buffer
            for (const msg of messages) {
              if (msg.startsWith("data: ")) {
                receivedEvents.push(msg.slice(6));
              }
            }
          });

          // Wait for connection, then trigger events
          setTimeout(async () => {
            try {
              // Create two events via API
              await fetchUrl(baseUrl, "/api/v1/finance/orders", {
                method: "POST",
                body: { symbol: "BTC/USDT", side: "buy", quantity: 0.001, currentPrice: 65000 },
              });
              await fetchUrl(baseUrl, "/api/v1/finance/orders/cancel", {
                method: "POST",
                body: { orderId: "ord-test-123" },
              });

              // Give SSE time to propagate
              setTimeout(() => {
                req.destroy();
                resolve();
              }, 100);
            } catch (err) {
              reject(err);
            }
          }, 100);
        });
        req.on("error", (err) => {
          if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
            reject(err);
          }
        });
      });

      // Verify received SSE events
      expect(receivedEvents.length).toBeGreaterThanOrEqual(2);
      const parsed = receivedEvents.map((e) => JSON.parse(e));
      expect(parsed.some((e: MockEvent) => e.type === "trade_executed")).toBe(true);
      expect(parsed.some((e: MockEvent) => e.type === "order_cancelled")).toBe(true);
    });
  });

  // ── Scenario: Order validation ──

  describe("Scenario: Order input validation", () => {
    it("rejects orders without required fields", async () => {
      const res = await fetchUrl(baseUrl, "/api/v1/finance/orders", {
        method: "POST",
        body: { symbol: "BTC/USDT" }, // missing side, quantity
      });
      expect(res.status).toBe(400);
      expect((res.body as Record<string, unknown>).error).toContain("Missing");
    });

    it("cancel order validates orderId", async () => {
      const res = await fetchUrl(baseUrl, "/api/v1/finance/orders/cancel", {
        method: "POST",
        body: {},
      });
      expect(res.status).toBe(400);
    });
  });

  // ── Scenario: API data endpoints ──

  describe("Scenario: JSON API data endpoints", () => {
    it("GET /api/v1/finance/config returns config shape", async () => {
      const res = await fetchUrl(baseUrl, "/api/v1/finance/config");
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.exchanges).toBeDefined();
      expect(body.trading).toBeDefined();
      expect(body.plugins).toBeDefined();
      expect((body.trading as Record<string, unknown>).enabled).toBe(true);
    });

    it("GET /api/v1/finance/exchange-health returns health data", async () => {
      const res = await fetchUrl(baseUrl, "/api/v1/finance/exchange-health");
      expect(res.status).toBe(200);
      const body = res.body as { exchanges: unknown[] };
      expect(body.exchanges).toHaveLength(1);
    });

    it("GET /api/v1/finance/strategy-arena returns pipeline data", async () => {
      const res = await fetchUrl(baseUrl, "/api/v1/finance/strategy-arena");
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.pipeline).toBeDefined();
      expect(body.gates).toBeDefined();
      const pipeline = body.pipeline as Record<string, number>;
      expect(pipeline.l0).toBe(1); // Delta Scalper
      expect(pipeline.l1).toBe(1); // Gamma Breakout
      expect(pipeline.l2).toBe(1); // Beta Mean Reversion
      expect(pipeline.l3).toBe(1); // Alpha Momentum
    });
  });
});

// ══════════════════════════════════════════════════════════════════
//  PART B: BROWSER USER JOURNEYS
//  Playwright-driven interaction tests against the dashboard UI.
// ══════════════════════════════════════════════════════════════════

describe.skipIf(!hasBrowser || !hasOverviewHtml)("Part B: Browser User Journeys", () => {
  let port: number;
  let baseUrl: string;
  let browser: Awaited<ReturnType<NonNullable<typeof chromium>["launch"]>>;
  let page: Awaited<ReturnType<typeof browser.newPage>>;
  const mock = createMockServer();

  beforeAll(async () => {
    port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    await new Promise<void>((resolve) => mock.server.listen(port, "127.0.0.1", resolve));
    browser = await chromium!.launch({
      executablePath: browserPath!,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  });

  beforeEach(async () => {
    mock.reset();
    page = await browser.newPage();
  });

  // ── Scenario 8: Morning Routine ──

  describe("Scenario 8: Morning routine — overview dashboard", () => {
    it("renders portfolio summary with equity, positions, strategies", async () => {
      await page.goto(`${baseUrl}/dashboard/overview`);
      await page.waitForLoadState("domcontentloaded");

      // Verify page title
      const title = await page.title();
      expect(title).toContain("Overview");

      // Verify topbar logo
      const logo = await page.textContent(".topbar__logo");
      expect(logo).toContain("OPENFINCLAW");

      // Verify emergency stop button exists
      expect(await page.locator("#estopBtn").isVisible()).toBe(true);

      // Verify SSE dot containers exist
      expect(await page.locator("#sseDots").isVisible()).toBe(true);

      // Verify stat pills render
      expect(await page.locator("#spPositions").isVisible()).toBe(true);
      expect(await page.locator("#spStrategies").isVisible()).toBe(true);
    });

    it("injects PAGE_DATA correctly into script context", async () => {
      await page.goto(`${baseUrl}/dashboard/overview`);
      await page.waitForLoadState("domcontentloaded");

      // Verify pageData is accessible in page context
      const pageData = await page.evaluate(
        () => (window as unknown as { pageData: unknown }).pageData,
      );
      expect(pageData).toBeDefined();
      expect((pageData as Record<string, unknown>).trading).toBeDefined();
      expect((pageData as Record<string, unknown>).config).toBeDefined();
    });
  });

  // ── Scenario 9: Navigation Chain ──

  describe("Scenario 9: Dashboard navigation & redirects", () => {
    it("navigates between all 4 unified dashboard pages", async () => {
      const pages = ["overview", "trading-desk", "strategy-arena", "strategy-lab"];
      for (const p of pages) {
        const res = await page.goto(`${baseUrl}/dashboard/${p}`);
        expect(res?.status()).toBe(200);
        const contentType = res?.headers()["content-type"];
        expect(contentType).toContain("text/html");
      }
    });

    it("legacy /dashboard/finance redirects to /dashboard/overview", async () => {
      const res = await page.goto(`${baseUrl}/dashboard/finance`);
      expect(page.url()).toContain("/dashboard/overview");
      expect(res?.status()).toBe(200);
    });

    it("legacy /dashboard/trading redirects to /dashboard/trading-desk", async () => {
      const res = await page.goto(`${baseUrl}/dashboard/trading`);
      expect(page.url()).toContain("/dashboard/trading-desk");
      expect(res?.status()).toBe(200);
    });

    it("legacy /dashboard/command-center redirects to /dashboard/trading-desk", async () => {
      const res = await page.goto(`${baseUrl}/dashboard/command-center`);
      expect(page.url()).toContain("/dashboard/trading-desk");
      expect(res?.status()).toBe(200);
    });

    it("legacy /dashboard/mission-control redirects to /dashboard/overview", async () => {
      const res = await page.goto(`${baseUrl}/dashboard/mission-control`);
      expect(page.url()).toContain("/dashboard/overview");
      expect(res?.status()).toBe(200);
    });

    it("strategy-related legacy paths redirect to strategy-arena", async () => {
      for (const path of ["/dashboard/evolution", "/dashboard/strategy", "/dashboard/arena"]) {
        const res = await page.goto(`${baseUrl}${path}`);
        expect(page.url()).toContain("/dashboard/strategy-arena");
        expect(res?.status()).toBe(200);
      }
    });

    it("/dashboard/fund redirects to /dashboard/strategy-lab", async () => {
      const res = await page.goto(`${baseUrl}/dashboard/fund`);
      expect(page.url()).toContain("/dashboard/strategy-lab");
      expect(res?.status()).toBe(200);
    });
  });

  // ── Scenario 10: Trading Desk ──

  describe("Scenario 10: Trading desk page structure", () => {
    it("renders with trading data injected", async () => {
      await page.goto(`${baseUrl}/dashboard/trading-desk`);
      await page.waitForLoadState("domcontentloaded");

      const pageData = await page.evaluate(
        () => (window as unknown as { pageData: unknown }).pageData,
      );
      expect(pageData).toBeDefined();
      const data = pageData as Record<string, unknown>;
      expect(data.trading).toBeDefined();
      expect(data.risk).toBeDefined();
    });

    it("has emergency stop button", async () => {
      await page.goto(`${baseUrl}/dashboard/trading-desk`);
      await page.waitForLoadState("domcontentloaded");
      expect(await page.locator("#estopBtn").isVisible()).toBe(true);
    });
  });

  // ── Scenario 11: Strategy Arena ──

  describe("Scenario 11: Strategy arena — pipeline & promotion gates", () => {
    it("renders with pipeline counts and promotion gates", async () => {
      await page.goto(`${baseUrl}/dashboard/strategy-arena`);
      await page.waitForLoadState("domcontentloaded");

      const pageData = await page.evaluate(
        () => (window as unknown as { pageData: unknown }).pageData,
      );
      expect(pageData).toBeDefined();
      const data = pageData as Record<string, unknown>;

      // Verify pipeline data
      const pipeline = data.pipeline as Record<string, number>;
      expect(pipeline.l0).toBe(1);
      expect(pipeline.l1).toBe(1);
      expect(pipeline.l2).toBe(1);
      expect(pipeline.l3).toBe(1);

      // Verify gates data
      const gates = data.gates as Record<string, Record<string, unknown>>;
      expect(gates.l1ToL2).toBeDefined();
      expect(gates.l1ToL2.sharpeMin).toBe(1.0);
      expect(gates.l2ToL3).toBeDefined();
      expect(gates.l2ToL3.requiresApproval).toBe(true);
    });
  });

  // ── Scenario 12: Full User Journey — Order → Approval via API + UI Refresh ──

  describe("Scenario 12: Full journey — place order, check pending, approve", () => {
    it("end-to-end order lifecycle visible in dashboard data", async () => {
      // Step 1: Open overview
      await page.goto(`${baseUrl}/dashboard/overview`);
      await page.waitForLoadState("domcontentloaded");

      let pageData = await page.evaluate(
        () => (window as unknown as { pageData: unknown }).pageData,
      );
      expect((pageData as { events: { pendingCount: number } }).events.pendingCount).toBe(0);

      // Step 2: Place a medium order via API (creates pending event)
      const orderRes = await fetchUrl(baseUrl, "/api/v1/finance/orders", {
        method: "POST",
        body: { symbol: "AVAX/USDT", side: "buy", quantity: 10, currentPrice: 30 },
      });
      expect(orderRes.status).toBe(202);
      const eventId = (orderRes.body as { eventId: string }).eventId;

      // Step 3: Refresh page → pending count should be 1
      await page.reload();
      await page.waitForLoadState("domcontentloaded");

      pageData = await page.evaluate(() => (window as unknown as { pageData: unknown }).pageData);
      expect((pageData as { events: { pendingCount: number } }).events.pendingCount).toBe(1);

      // Step 4: Approve via API
      const approveRes = await fetchUrl(baseUrl, "/api/v1/finance/events/approve", {
        method: "POST",
        body: { id: eventId, action: "approve" },
      });
      expect(approveRes.status).toBe(200);

      // Step 5: Refresh → pending count should be 0, events should show both
      await page.reload();
      await page.waitForLoadState("domcontentloaded");

      pageData = await page.evaluate(() => (window as unknown as { pageData: unknown }).pageData);
      const evData = (pageData as { events: { events: MockEvent[]; pendingCount: number } }).events;
      expect(evData.pendingCount).toBe(0);
      expect(evData.events).toHaveLength(2); // approved + executed
    });
  });
});
