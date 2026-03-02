/**
 * Combined E2E test for the FinClaw Fund Dashboard + Trading Dashboard.
 *
 * Spins up ONE HTTP server serving both dashboards with SSE streams and REST
 * endpoints, then uses Playwright to verify rendering, SSE updates, and edge cases
 * across both dashboards in 6 test scenarios (A–F).
 *
 * Run: pnpm vitest run test/fin-quant-dashboard.e2e.test.ts --config vitest.e2e.config.ts
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chromium,
  browserPath,
  hasBrowser,
  getFreePort,
  stripChartJsCdn,
} from "./helpers/e2e-browser.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const FUND_HTML_PATH = join(
  __dirname,
  "../extensions/fin-fund-manager/dashboard/fund-dashboard.html",
);
const FUND_CSS_PATH = join(
  __dirname,
  "../extensions/fin-fund-manager/dashboard/fund-dashboard.css",
);
const TRADING_HTML_PATH = join(
  __dirname,
  "../extensions/fin-core/dashboard/trading-dashboard.html",
);
const TRADING_CSS_PATH = join(__dirname, "../extensions/fin-core/dashboard/trading-dashboard.css");

// ── Mock data ──

const MOCK_FUND_DATA = {
  status: {
    totalEquity: 125000,
    todayPnl: 1250,
    todayPnlPct: 1.01,
    riskLevel: "medium",
    dailyDrawdown: -2.5,
    byLevel: { L0_INCUBATE: 2, L1_BACKTEST: 1, L2_PAPER: 3, L3_LIVE: 1 },
    lastRebalanceAt: new Date().toISOString(),
  },
  leaderboard: [
    {
      rank: 1,
      strategyId: "s-alpha",
      strategyName: "Alpha Momentum",
      level: "L3_LIVE",
      fitness: 0.92,
      confidenceMultiplier: 1.0,
      leaderboardScore: 0.92,
      sharpe: 2.1,
      maxDrawdown: -8.5,
      totalTrades: 156,
    },
    {
      rank: 2,
      strategyId: "s-beta",
      strategyName: "Beta Mean Reversion",
      level: "L2_PAPER",
      fitness: 0.78,
      confidenceMultiplier: 0.85,
      leaderboardScore: 0.66,
      sharpe: 1.4,
      maxDrawdown: -12.3,
      totalTrades: 89,
    },
    {
      rank: 3,
      strategyId: "s-gamma",
      strategyName: "Gamma Breakout",
      level: "L2_PAPER",
      fitness: 0.65,
      confidenceMultiplier: 0.7,
      leaderboardScore: 0.46,
      sharpe: 0.9,
      maxDrawdown: -18.1,
      totalTrades: 42,
    },
  ],
  allocations: {
    items: [
      { strategyId: "s-alpha", capitalUsd: 50000, weightPct: 40, reason: "Top ranked" },
      { strategyId: "s-beta", capitalUsd: 25000, weightPct: 20, reason: "Diversification" },
    ],
    totalAllocated: 75000,
    cashReserve: 50000,
    totalCapital: 125000,
  },
  risk: {
    totalEquity: 125000,
    todayPnl: 1250,
    todayPnlPct: 1.01,
    dailyDrawdown: -2.5,
    maxAllowedDrawdown: -10,
    riskLevel: "medium",
    activeStrategies: 3,
    exposurePct: 60,
    cashReservePct: 40,
    scaleFactor: 1.0,
    actions: [],
  },
};

const MOCK_TRADING_DATA = {
  summary: {
    totalEquity: 105000,
    dailyPnl: 500,
    dailyPnlPct: 0.48,
    winRate: 62.5,
    avgSharpe: 1.35,
  },
  positions: [
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
      side: "long",
      quantity: 5.0,
      entryPrice: 3200,
      currentPrice: 3150,
      unrealizedPnl: -250,
    },
  ],
  orders: [
    {
      filledAt: new Date().toISOString(),
      symbol: "BTC/USDT",
      side: "buy",
      quantity: 0.5,
      fillPrice: 65000,
      status: "filled",
      commission: 6.5,
      strategyId: "s-alpha",
    },
  ],
  snapshots: Array.from({ length: 30 }, (_, i) => ({
    timestamp: new Date(Date.now() - (29 - i) * 86400000).toISOString(),
    equity: 100000 + i * 200 + Math.sin(i) * 500,
  })),
  strategies: [
    {
      id: "s-alpha",
      name: "Alpha Momentum",
      level: "L3_LIVE",
      totalReturn: 12.5,
      sharpe: 2.1,
      maxDrawdown: -8.5,
      totalTrades: 156,
    },
    {
      id: "s-beta",
      name: "Beta Mean Reversion",
      level: "L2_PAPER",
      totalReturn: 5.8,
      sharpe: 1.4,
      maxDrawdown: -12.3,
      totalTrades: 89,
    },
    {
      id: "s-gamma",
      name: "Gamma Breakout",
      level: "L1_BACKTEST",
      totalReturn: 3.2,
      sharpe: 0.9,
      maxDrawdown: -18.1,
      totalTrades: 42,
    },
  ],
  backtests: [
    {
      strategyId: "s-alpha",
      totalReturn: 15.2,
      sharpe: 2.3,
      sortino: 3.1,
      maxDrawdown: -7.2,
      winRate: 68,
      profitFactor: 2.1,
      totalTrades: 200,
      finalEquity: 115200,
      initialCapital: 100000,
    },
  ],
  allocations: {
    items: [
      { strategyId: "s-alpha", capitalUsd: 50000 },
      { strategyId: "s-beta", capitalUsd: 25000 },
    ],
    cashReserve: 30000,
  },
};

// ── Combined server ──

interface CombinedServer {
  server: http.Server;
  sseConnections: { fund: http.ServerResponse[]; trading: http.ServerResponse[] };
}

function createCombinedServer(fundData: unknown, tradingData: unknown): CombinedServer {
  const sseConnections: { fund: http.ServerResponse[]; trading: http.ServerResponse[] } = {
    fund: [],
    trading: [],
  };

  const fundHtml = readFileSync(FUND_HTML_PATH, "utf-8");
  const fundCss = readFileSync(FUND_CSS_PATH, "utf-8");
  const tradingHtml = readFileSync(TRADING_HTML_PATH, "utf-8");
  const tradingCss = readFileSync(TRADING_CSS_PATH, "utf-8");

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    // Fund SSE stream
    if (path === "/api/v1/fund/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(fundData)}\n\n`);
      sseConnections.fund.push(res);
      req.on("close", () => {
        sseConnections.fund = sseConnections.fund.filter((c) => c !== res);
      });
      return;
    }

    // Trading SSE stream
    if (path === "/api/v1/finance/trading/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(tradingData)}\n\n`);
      sseConnections.trading.push(res);
      req.on("close", () => {
        sseConnections.trading = sseConnections.trading.filter((c) => c !== res);
      });
      return;
    }

    // Fund REST endpoints
    if (path === "/api/v1/fund/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify((fundData as typeof MOCK_FUND_DATA).status));
      return;
    }
    if (path === "/api/v1/fund/leaderboard") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify((fundData as typeof MOCK_FUND_DATA).leaderboard));
      return;
    }

    // Trading REST endpoint
    if (path === "/api/v1/finance/trading") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(tradingData));
      return;
    }

    // Fund dashboard HTML
    if (path === "/dashboard/fund") {
      const safeJson = JSON.stringify(fundData).replace(/<\//g, "<\\/");
      const page = stripChartJsCdn(fundHtml)
        .replace("/*__FUND_CSS__*/", fundCss)
        .replace("/*__FUND_DATA__*/ {}", safeJson);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }

    // Trading dashboard HTML
    if (path === "/dashboard/trading") {
      const safeJson = JSON.stringify(tradingData).replace(/<\//g, "<\\/");
      const page = stripChartJsCdn(tradingHtml)
        .replace("/*__TRADING_CSS__*/", tradingCss)
        .replace("/*__TRADING_DATA__*/ {}", safeJson);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  return { server, sseConnections };
}

// ── Tests ──

const E2E_TIMEOUT = 60_000;

describe.skipIf(!hasBrowser)("Quant Dashboard Combined E2E (Playwright)", () => {
  let browser: Awaited<ReturnType<NonNullable<typeof chromium>["launch"]>> | undefined;
  let baseUrl: string;
  let combinedServer: CombinedServer;

  beforeAll(async () => {
    if (!chromium) {
      return;
    }
    const port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    combinedServer = createCombinedServer(MOCK_FUND_DATA, MOCK_TRADING_DATA);
    await new Promise<void>((resolve) => combinedServer.server.listen(port, "127.0.0.1", resolve));
    browser = await chromium.launch({ executablePath: browserPath, headless: true });
  }, E2E_TIMEOUT);

  afterAll(async () => {
    // Drain all open SSE connections before closing the server
    for (const conn of [
      ...combinedServer.sseConnections.fund,
      ...combinedServer.sseConnections.trading,
    ]) {
      try {
        conn.end();
      } catch {
        /* ignore */
      }
    }
    await browser?.close();
    await new Promise<void>((resolve) => combinedServer.server.close(() => resolve()));
  });

  // ── Helpers ──

  async function openFundDashboard() {
    const page = await browser!.newPage();
    await page.goto(`${baseUrl}/dashboard/fund`, { waitUntil: "load", timeout: 30000 });
    // Wait until equity hero element is populated (not the initial placeholder)
    await page.waitForFunction(
      () => {
        const el = document.getElementById("hero-equity");
        return el && el.textContent !== "" && el.textContent !== "$0.00" && el.textContent !== "0";
      },
      { timeout: 15000 },
    );
    return page;
  }

  async function openTradingDashboard() {
    const page = await browser!.newPage();
    await page.goto(`${baseUrl}/dashboard/trading`, { waitUntil: "load", timeout: 30000 });
    // Wait until equity hero element is populated
    await page.waitForFunction(
      () => {
        const el = document.getElementById("hero-equity");
        return el && el.textContent !== "" && el.textContent !== "$0.00" && el.textContent !== "0";
      },
      { timeout: 15000 },
    );
    return page;
  }

  // ── Scenario A: Fund dashboard static rendering ──

  it(
    "A: Fund dashboard renders equity, leaderboard, and risk badge",
    { timeout: E2E_TIMEOUT },
    async () => {
      const page = await openFundDashboard();

      // Hero equity must contain 125,000
      const heroEquity = await page.locator("#hero-equity").textContent();
      expect(heroEquity).toContain("125,000");

      // Leaderboard must show 3 strategy rows
      const rows = await page.locator("#leaderboard-body tr").count();
      expect(rows).toBe(3);

      // Risk badge must show "medium"
      const riskBadge = page.locator("#risk-badge, .risk-badge, [data-risk-level]").first();
      const riskText = await riskBadge.textContent();
      expect(riskText?.toLowerCase()).toContain("medium");

      await page.close();
    },
  );

  // ── Scenario B: Trading dashboard static rendering ──

  it(
    "B: Trading dashboard renders positions, equity chart, and strategy cards",
    { timeout: E2E_TIMEOUT },
    async () => {
      const page = await openTradingDashboard();

      // Positions table must have 2 rows
      const posRows = await page
        .locator("#positions-body tr, #positions-table tbody tr, .position-row")
        .count();
      expect(posRows).toBe(2);

      // Equity chart container (or canvas) must be visible
      const chartContainer = page
        .locator("#equity-chart, #equity-chart-container, canvas, .chart-container")
        .first();
      expect(await chartContainer.isVisible()).toBe(true);

      // Strategy grid must have 3 cards
      const cards = await page.locator(".strategy-card").count();
      expect(cards).toBe(3);

      await page.close();
    },
  );

  // ── Scenario C: Fund SSE equity update ──

  it(
    "C: SSE pushes new equity → fund dashboard updates without refresh",
    { timeout: E2E_TIMEOUT },
    async () => {
      const page = await openFundDashboard();

      // Capture initial equity text
      const initial = await page.locator("#hero-equity").textContent();

      // Push an updated fund payload with totalEquity = 130000
      const updatedData = {
        ...MOCK_FUND_DATA,
        status: { ...MOCK_FUND_DATA.status, totalEquity: 130000, todayPnl: 6250 },
      };
      for (const conn of combinedServer.sseConnections.fund) {
        try {
          conn.write(`data: ${JSON.stringify(updatedData)}\n\n`);
        } catch {
          /* connection may have closed */
        }
      }

      // Wait for DOM to show the new value
      await page.waitForFunction(
        (oldText) => document.getElementById("hero-equity")?.textContent !== oldText,
        initial,
        { timeout: 15000 },
      );

      const updated = await page.locator("#hero-equity").textContent();
      expect(updated).toContain("130,000");

      await page.close();
    },
  );

  // ── Scenario D: Trading SSE — new strategy card appears ──

  it(
    "D: SSE pushes 4th strategy → new card appears on trading dashboard",
    { timeout: E2E_TIMEOUT },
    async () => {
      const page = await openTradingDashboard();

      // Verify initial 3 cards
      const initialCards = await page.locator(".strategy-card").count();
      expect(initialCards).toBe(3);

      // Push trading data with 4 strategies
      const newStrategy = {
        id: "s-delta",
        name: "Delta Scalper",
        level: "L0_INCUBATE",
        totalReturn: 1.2,
        sharpe: 0.5,
        maxDrawdown: -22.0,
        totalTrades: 15,
      };
      const updatedTrading = {
        ...MOCK_TRADING_DATA,
        strategies: [...MOCK_TRADING_DATA.strategies, newStrategy],
      };
      for (const conn of combinedServer.sseConnections.trading) {
        try {
          conn.write(`data: ${JSON.stringify(updatedTrading)}\n\n`);
        } catch {
          /* connection may have closed */
        }
      }

      // Wait for 4th card to appear
      await page.waitForFunction(() => document.querySelectorAll(".strategy-card").length >= 4, {
        timeout: 15000,
      });

      const finalCards = await page.locator(".strategy-card").count();
      expect(finalCards).toBe(4);

      await page.close();
    },
  );

  // ── Scenario E: Trading SSE — new order row appears ──

  it(
    "E: SSE pushes new order → new row appears in orders table",
    { timeout: E2E_TIMEOUT },
    async () => {
      const page = await openTradingDashboard();

      // Capture initial order row count
      const initialRows = await page.locator("#orders-body tr, #orders-table tbody tr").count();

      // Push trading data with an additional order
      const newOrder = {
        filledAt: new Date().toISOString(),
        symbol: "SOL/USDT",
        side: "buy",
        quantity: 10,
        fillPrice: 185,
        status: "filled",
        commission: 1.85,
        strategyId: "s-beta",
      };
      const updatedTrading = {
        ...MOCK_TRADING_DATA,
        orders: [...MOCK_TRADING_DATA.orders, newOrder],
      };
      for (const conn of combinedServer.sseConnections.trading) {
        try {
          conn.write(`data: ${JSON.stringify(updatedTrading)}\n\n`);
        } catch {
          /* connection may have closed */
        }
      }

      // Wait for a new row to appear in whichever table element the dashboard uses
      await page.waitForFunction(
        (prev) => {
          const body =
            document.getElementById("orders-body") ?? document.querySelector("#orders-table tbody");
          return (body?.querySelectorAll("tr").length ?? 0) > prev;
        },
        initialRows,
        { timeout: 15000 },
      );

      const finalRows = await page.locator("#orders-body tr, #orders-table tbody tr").count();
      expect(finalRows).toBe(initialRows + 1);

      await page.close();
    },
  );

  // ── Scenario F: Edge cases ──

  it(
    "F: Edge cases — empty data placeholders, negative PnL styling, XSS safety",
    { timeout: E2E_TIMEOUT },
    async () => {
      // ── F1: Empty fund data + negative PnL ──
      const edgePort = await getFreePort();
      const edgeFundData = {
        ...MOCK_FUND_DATA,
        status: { ...MOCK_FUND_DATA.status, totalEquity: 0, todayPnl: -5000, todayPnlPct: -3.85 },
        leaderboard: [],
        allocations: { items: [], totalAllocated: 0, cashReserve: 0, totalCapital: 0 },
      };
      const edgeTradingData = { ...MOCK_TRADING_DATA, positions: [], orders: [], strategies: [] };
      const edgeServer = createCombinedServer(edgeFundData, edgeTradingData);
      await new Promise<void>((r) => edgeServer.server.listen(edgePort, "127.0.0.1", r));

      try {
        const page = await browser!.newPage();
        await page.goto(`http://127.0.0.1:${edgePort}/dashboard/fund`, {
          waitUntil: "load",
          timeout: 30000,
        });
        // Allow rendering to complete
        await page.waitForTimeout(2000);

        // Empty leaderboard: 0 rows or at most 1 placeholder row
        const rows = await page.locator("#leaderboard-body tr").count();
        expect(rows).toBeLessThanOrEqual(1);

        // Negative PnL element must have "negative"/"loss" class OR display a minus sign
        const pnlEl = page.locator("#hero-pnl, .pnl-value, [data-pnl]").first();
        const pnlClasses = await pnlEl.getAttribute("class");
        const pnlText = await pnlEl.textContent();
        const hasNegativeIndicator =
          pnlClasses?.includes("negative") ||
          pnlClasses?.includes("loss") ||
          pnlText?.includes("-");
        expect(hasNegativeIndicator).toBe(true);

        await page.close();
      } finally {
        for (const conn of [
          ...edgeServer.sseConnections.fund,
          ...edgeServer.sseConnections.trading,
        ]) {
          try {
            conn.end();
          } catch {
            /* ignore */
          }
        }
        edgeServer.server.close();
      }

      // ── F2: XSS safety — script tag in strategy name must not execute ──
      const xssPort = await getFreePort();
      const xssData = {
        ...MOCK_TRADING_DATA,
        strategies: [
          {
            id: "xss",
            name: '<script>alert("xss")</script>',
            level: "L0_INCUBATE",
            totalReturn: 0,
            sharpe: 0,
            maxDrawdown: 0,
            totalTrades: 0,
          },
        ],
      };
      const xssServer = createCombinedServer(MOCK_FUND_DATA, xssData);
      await new Promise<void>((r) => xssServer.server.listen(xssPort, "127.0.0.1", r));

      try {
        const xssPage = await browser!.newPage();
        let alertFired = false;
        xssPage.on("dialog", () => {
          alertFired = true;
        });
        await xssPage.goto(`http://127.0.0.1:${xssPort}/dashboard/trading`, {
          waitUntil: "load",
          timeout: 30000,
        });
        // Give any injected scripts a window to execute
        await xssPage.waitForTimeout(3000);
        expect(alertFired).toBe(false);
        await xssPage.close();
      } finally {
        for (const conn of [
          ...xssServer.sseConnections.fund,
          ...xssServer.sseConnections.trading,
        ]) {
          try {
            conn.end();
          } catch {
            /* ignore */
          }
        }
        xssServer.server.close();
      }
    },
  );
});
