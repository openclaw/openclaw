/**
 * Standalone stateful mock server for LLM-driven E2E testing.
 *
 * Extracted from test/fin-user-journeys.e2e.test.ts to run independently.
 * Provides the full dashboard HTML + API endpoints + SSE stream.
 *
 * Usage:
 *   npx tsx test/e2e-llm/mock-server.ts
 *   # → Mock server listening on http://localhost:18900
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MOCK_PORT ?? 18900);

// ── Paths ──

const DASHBOARD_DIR = join(__dirname, "../../extensions/fin-core/dashboard");

// ══════════════════════════════════════════════════════════════════
//  Types & Constants
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

// ══════════════════════════════════════════════════════════════════
//  Stateful Mock Server
// ══════════════════════════════════════════════════════════════════

let events: MockEvent[] = [];
let riskConfig: MockRiskConfig = { ...DEFAULT_RISK_CONFIG };
let eventCounter = 0;
const sseClients: http.ServerResponse[] = [];

function addEvent(ev: Omit<MockEvent, "id" | "timestamp">): MockEvent {
  eventCounter++;
  const event: MockEvent = {
    ...ev,
    id: `evt-${eventCounter}`,
    timestamp: new Date().toISOString(),
  };
  events.push(event);
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
  riskConfig = { ...DEFAULT_RISK_CONFIG };
}

// ── Dashboard templates ──

/** Strip Chart.js CDN <script> tags to avoid network fetch in tests. */
function stripChartJsCdn(html: string): string {
  return html.replace(/<script[^>]*cdn[^>]*chart\.js[^>]*><\/script>/gi, "");
}

let sharedCss = "";
const templates: Record<string, { html: string; css: string }> = {};

try {
  sharedCss = readFileSync(join(DASHBOARD_DIR, "unified-dashboard.css"), "utf-8");
} catch {
  /* ok — dashboard HTML might not exist */
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

// ── Data gathering ──

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

// ── HTTP helpers ──

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
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
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

// ══════════════════════════════════════════════════════════════════
//  HTTP Server
// ══════════════════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "";
  const method = req.method ?? "GET";

  // ── CORS preflight ──
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  // ── Test reset endpoint ──
  if (method === "POST" && url === "/api/test/reset") {
    reset();
    return json(res, 200, { status: "reset", message: "State reset to defaults" });
  }

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
      "Access-Control-Allow-Origin": "*",
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
      detail: "Approved and executed",
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

// ── Start ──

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Mock server listening on http://localhost:${PORT}`);
  console.log("Routes:");
  console.log("  GET  /dashboard/overview");
  console.log("  GET  /dashboard/trading-desk");
  console.log("  GET  /dashboard/strategy-arena");
  console.log("  GET  /dashboard/strategy-lab");
  console.log("  GET  /api/v1/finance/config");
  console.log("  GET  /api/v1/finance/exchange-health");
  console.log("  GET  /api/v1/finance/events");
  console.log("  GET  /api/v1/finance/events/stream (SSE)");
  console.log("  GET  /api/v1/finance/strategy-arena");
  console.log("  POST /api/v1/finance/orders");
  console.log("  POST /api/v1/finance/orders/cancel");
  console.log("  POST /api/v1/finance/events/approve");
  console.log("  POST /api/v1/finance/risk/evaluate");
  console.log("  POST /api/v1/finance/emergency-stop");
  console.log("  POST /api/test/reset");
  console.log("\nPress Ctrl+C to stop.");
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  for (const client of sseClients) {
    try {
      client.end();
    } catch {
      // ignore
    }
  }
  server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
