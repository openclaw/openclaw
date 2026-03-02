/**
 * E2E tests for the Unified Dashboard pages (overview, trading-desk, strategy-lab).
 *
 * Covers 7 test dimensions:
 *  1. Route tests — verify /dashboard/* pages return 200 HTML
 *  2. Redirect tests — verify legacy routes return 302 to new paths
 *  3. HTML content tests — verify each page contains expected sections/elements
 *  4. Data injection tests — verify PAGE_DATA is correctly injected
 *  5. CSS injection tests — verify SHARED_CSS and PAGE_CSS are injected
 *  6. Template renderer unit tests — renderUnifiedDashboard()
 *  7. Data gathering unit tests — gatherOverviewData(), gatherStrategyLabData()
 *
 * Run: pnpm vitest run test/fin-unified-dashboard.e2e.test.ts --config vitest.e2e.config.ts
 */
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chromium,
  browserPath,
  hasBrowser,
  getFreePort,
  fetchJson,
  stripChartJsCdn,
} from "./helpers/e2e-browser.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Paths ──

const DASHBOARD_DIR = join(__dirname, "../extensions/fin-core/dashboard");
const SHARED_CSS_PATH = join(DASHBOARD_DIR, "unified-dashboard.css");
const OVERVIEW_HTML_PATH = join(DASHBOARD_DIR, "overview.html");
const OVERVIEW_CSS_PATH = join(DASHBOARD_DIR, "overview.css");
const TRADING_DESK_HTML_PATH = join(DASHBOARD_DIR, "trading-desk.html");
const TRADING_DESK_CSS_PATH = join(DASHBOARD_DIR, "trading-desk.css");
const STRATEGY_LAB_HTML_PATH = join(DASHBOARD_DIR, "strategy-lab.html");
const STRATEGY_LAB_CSS_PATH = join(DASHBOARD_DIR, "strategy-lab.css");

const hasOverviewHtml = existsSync(OVERVIEW_HTML_PATH);
const hasTradingDeskHtml = existsSync(TRADING_DESK_HTML_PATH);
const hasStrategyLabHtml = existsSync(STRATEGY_LAB_HTML_PATH);
const hasAllUnifiedHtml = hasOverviewHtml && hasTradingDeskHtml && hasStrategyLabHtml;

// ── Mock data — Overview (full superset) ──

const MOCK_OVERVIEW_DATA = {
  trading: {
    summary: {
      totalEquity: 125430,
      dailyPnl: 2890,
      dailyPnlPct: 2.3,
      positionCount: 5,
      strategyCount: 12,
      winRate: 0.68,
      avgSharpe: 1.2,
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
        side: "short",
        quantity: 5.0,
        entryPrice: 3200,
        currentPrice: 3150,
        unrealizedPnl: 250,
      },
      {
        symbol: "SOL/USDT",
        side: "long",
        quantity: 20,
        entryPrice: 180,
        currentPrice: 185,
        unrealizedPnl: 100,
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
      {
        filledAt: new Date().toISOString(),
        symbol: "ETH/USDT",
        side: "sell",
        quantity: 5.0,
        fillPrice: 3200,
        status: "filled",
        commission: 3.2,
        strategyId: "s-beta",
      },
    ],
    snapshots: Array.from({ length: 30 }, (_, i) => ({
      timestamp: new Date(Date.now() - (29 - i) * 86400000).toISOString(),
      equity: 120000 + i * 200 + Math.sin(i) * 500,
    })),
    strategies: [
      {
        id: "s-alpha",
        name: "Alpha Momentum",
        level: 3,
        totalReturn: 12.5,
        sharpe: 2.1,
        maxDrawdown: -8.5,
        totalTrades: 156,
      },
      {
        id: "s-beta",
        name: "Beta Mean Reversion",
        level: 2,
        totalReturn: 5.8,
        sharpe: 1.4,
        maxDrawdown: -12.3,
        totalTrades: 89,
      },
      {
        id: "s-gamma",
        name: "Gamma Breakout",
        level: 1,
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
        { strategyId: "s-alpha", capitalUsd: 50000, weightPct: 40, reason: "Top ranked" },
        { strategyId: "s-beta", capitalUsd: 25000, weightPct: 20, reason: "Diversification" },
      ],
      totalAllocated: 75000,
      cashReserve: 50430,
      totalCapital: 125430,
    },
  },
  events: {
    events: [
      {
        id: "e1",
        type: "trade_executed",
        title: "BUY 0.5 BTC/USDT",
        detail: "Filled at $65,000",
        status: "completed",
        timestamp: new Date().toISOString(),
      },
      {
        id: "e2",
        type: "trade_pending",
        title: "SELL 1.0 ETH/USDT",
        detail: "Awaiting approval",
        status: "pending",
        timestamp: new Date().toISOString(),
      },
      {
        id: "e3",
        type: "alert_triggered",
        title: "BTC crossed $70K",
        detail: "Price alert triggered",
        status: "completed",
        timestamp: new Date().toISOString(),
      },
    ],
    pendingCount: 1,
  },
  alerts: [
    {
      id: "a1",
      symbol: "BTC/USDT",
      condition: "price_above",
      price: 70000,
      description: "BTC > $70K",
    },
    {
      id: "a2",
      symbol: "ETH/USDT",
      condition: "price_below",
      price: 3000,
      description: "ETH < $3K",
    },
  ],
  risk: {
    enabled: true,
    maxAutoTradeUsd: 5000,
    confirmThresholdUsd: 1000,
    maxDailyLossUsd: 10000,
  },
  fund: {
    allocations: [
      { strategyId: "s-alpha", capitalUsd: 50000 },
      { strategyId: "s-beta", capitalUsd: 25000 },
    ],
    totalCapital: 125430,
    riskLevel: "normal",
  },
  config: {
    generatedAt: new Date().toISOString(),
    exchanges: [
      { id: "binance", name: "Binance" },
      { id: "coinbase", name: "Coinbase" },
    ],
    trading: {
      enabled: true,
      maxAutoTradeUsd: 5000,
      confirmThresholdUsd: 1000,
      maxDailyLossUsd: 10000,
      maxPositionPct: 0.25,
      maxLeverage: 3,
      allowedPairs: ["BTC/USDT", "ETH/USDT", "SOL/USDT"],
      blockedPairs: [],
    },
    plugins: {
      total: 12,
      enabled: 10,
      entries: [
        { id: "fin-core", enabled: true },
        { id: "fin-trading", enabled: true },
        { id: "fin-paper-trading", enabled: true },
      ],
    },
  },
};

// ── Mock data — Trading Desk (command center shape) ──

const MOCK_TRADING_DESK_DATA = {
  trading: MOCK_OVERVIEW_DATA.trading,
  events: MOCK_OVERVIEW_DATA.events,
  alerts: MOCK_OVERVIEW_DATA.alerts,
  risk: MOCK_OVERVIEW_DATA.risk,
};

// ── Mock data — Strategy Lab ──

const MOCK_STRATEGY_LAB_DATA = {
  strategies: MOCK_OVERVIEW_DATA.trading.strategies,
  backtests: MOCK_OVERVIEW_DATA.trading.backtests,
  allocations: MOCK_OVERVIEW_DATA.trading.allocations,
  fund: MOCK_OVERVIEW_DATA.fund,
  summary: MOCK_OVERVIEW_DATA.trading.summary,
};

// ── Empty data variants for edge-case tests ──

const EMPTY_OVERVIEW_DATA = {
  trading: {
    summary: {
      totalEquity: 0,
      dailyPnl: 0,
      dailyPnlPct: 0,
      positionCount: 0,
      strategyCount: 0,
      winRate: null,
      avgSharpe: null,
    },
    positions: [],
    orders: [],
    snapshots: [],
    strategies: [],
    backtests: [],
    allocations: { items: [], totalAllocated: 0, cashReserve: 0, totalCapital: 0 },
  },
  events: { events: [], pendingCount: 0 },
  alerts: [],
  risk: { enabled: false, maxAutoTradeUsd: 0, confirmThresholdUsd: 0, maxDailyLossUsd: 0 },
  fund: { allocations: [], totalCapital: 0, riskLevel: "normal" },
  config: {
    exchanges: [],
    trading: {
      enabled: false,
      maxAutoTradeUsd: 0,
      confirmThresholdUsd: 0,
      maxDailyLossUsd: 0,
      maxPositionPct: 0,
      maxLeverage: 1,
      allowedPairs: [],
      blockedPairs: [],
    },
    plugins: { total: 0, enabled: 0, entries: [] },
  },
};

const NEGATIVE_PNL_DATA = {
  ...MOCK_OVERVIEW_DATA,
  trading: {
    ...MOCK_OVERVIEW_DATA.trading,
    summary: {
      ...MOCK_OVERVIEW_DATA.trading.summary,
      totalEquity: 95000,
      dailyPnl: -5000,
      dailyPnlPct: -5.0,
    },
    positions: [
      {
        symbol: "BTC/USDT",
        side: "long",
        quantity: 1.0,
        entryPrice: 70000,
        currentPrice: 65000,
        unrealizedPnl: -5000,
      },
    ],
  },
};

const XSS_STRATEGY_DATA = {
  ...MOCK_OVERVIEW_DATA,
  trading: {
    ...MOCK_OVERVIEW_DATA.trading,
    strategies: [
      {
        id: "xss-test",
        name: '<script>alert("xss")</script>',
        level: 1,
        totalReturn: 0,
        sharpe: 0,
        maxDrawdown: 0,
        totalTrades: 0,
      },
    ],
  },
};

// ══════════════════════════════════════════════════════════════════
// SECTION 6: Template Renderer Unit Tests
// ══════════════════════════════════════════════════════════════════

describe("renderUnifiedDashboard", () => {
  let renderUnifiedDashboard: typeof import("../extensions/fin-core/src/template-renderer.ts").renderUnifiedDashboard;
  let renderDashboard: typeof import("../extensions/fin-core/src/template-renderer.ts").renderDashboard;

  beforeAll(async () => {
    const mod = await import("../extensions/fin-core/src/template-renderer.ts");
    renderUnifiedDashboard = mod.renderUnifiedDashboard;
    renderDashboard = mod.renderDashboard;
  });

  const TEMPLATE_HTML =
    "<style>/*__SHARED_CSS__*/</style><style>/*__PAGE_CSS__*/</style><script>var D=/*__PAGE_DATA__*/ {};</script>";

  it("injects shared CSS into __SHARED_CSS__ placeholder", () => {
    const template = { html: TEMPLATE_HTML, css: ".page{}", sharedCss: ".shared{color:red}" };
    const result = renderUnifiedDashboard(template, { test: 1 });
    expect(result).toContain(".shared{color:red}");
    expect(result).not.toContain("/*__SHARED_CSS__*/");
  });

  it("injects page CSS into __PAGE_CSS__ placeholder", () => {
    const template = { html: TEMPLATE_HTML, css: ".page-specific{margin:0}", sharedCss: ".s{}" };
    const result = renderUnifiedDashboard(template, { test: 1 });
    expect(result).toContain(".page-specific{margin:0}");
    expect(result).not.toContain("/*__PAGE_CSS__*/");
  });

  it("injects JSON data into __PAGE_DATA__ placeholder", () => {
    const template = { html: TEMPLATE_HTML, css: "", sharedCss: ".s{}" };
    const data = { equity: 125000, name: "test-fund", nested: { a: 1 } };
    const result = renderUnifiedDashboard(template, data);
    expect(result).toContain('"equity":125000');
    expect(result).toContain('"name":"test-fund"');
    expect(result).toContain('"nested":{"a":1}');
    expect(result).not.toContain("/*__PAGE_DATA__*/");
  });

  it("returns null when html is empty", () => {
    const template = { html: "", css: ".page{}", sharedCss: ".shared{}" };
    expect(renderUnifiedDashboard(template, { test: 1 })).toBeNull();
  });

  it("returns null when sharedCss is empty", () => {
    const template = { html: TEMPLATE_HTML, css: ".page{}", sharedCss: "" };
    expect(renderUnifiedDashboard(template, { test: 1 })).toBeNull();
  });

  it("renders successfully even when page css is empty", () => {
    const template = { html: TEMPLATE_HTML, css: "", sharedCss: ".s{}" };
    const result = renderUnifiedDashboard(template, { ok: true });
    expect(result).not.toBeNull();
    expect(result).toContain('"ok":true');
  });

  it("escapes </ in JSON to prevent script injection", () => {
    const template = { html: TEMPLATE_HTML, css: "", sharedCss: ".s{}" };
    const data = { xss: "</script><script>alert(1)</script>" };
    const result = renderUnifiedDashboard(template, data);
    expect(result).not.toContain("</script><script>alert(1)");
    expect(result).toContain("<\\/script>");
  });

  it("escapes multiple </ sequences", () => {
    const template = { html: TEMPLATE_HTML, css: "", sharedCss: ".s{}" };
    const data = { a: "</div>", b: "</span>", c: "</style>" };
    const result = renderUnifiedDashboard(template, data);
    expect(result).not.toContain("</div>");
    expect(result).not.toContain("</span>");
    expect(result).toContain("<\\/div>");
    expect(result).toContain("<\\/span>");
  });

  it("handles large data payloads", () => {
    const template = { html: TEMPLATE_HTML, css: "", sharedCss: ".s{}" };
    const result = renderUnifiedDashboard(template, MOCK_OVERVIEW_DATA);
    expect(result).not.toBeNull();
    expect(result).toContain("125430");
    expect(result).toContain("Alpha Momentum");
  });

  it("handles empty data object", () => {
    const template = { html: TEMPLATE_HTML, css: "", sharedCss: ".s{}" };
    const result = renderUnifiedDashboard(template, {});
    expect(result).not.toBeNull();
    expect(result).toContain("{}");
  });

  it("preserves HTML structure around replaced placeholders", () => {
    const html =
      "<!doctype html><html><head><style>/*__SHARED_CSS__*/</style><style>/*__PAGE_CSS__*/</style></head><body><script>var D=/*__PAGE_DATA__*/ {};</script></body></html>";
    const template = { html, css: ".p{}", sharedCss: ".s{}" };
    const result = renderUnifiedDashboard(template, { v: 1 });
    expect(result).toContain("<!doctype html>");
    expect(result).toContain("<html>");
    expect(result).toContain("</html>");
    expect(result).toContain("<head>");
    expect(result).toContain("<body>");
  });

  // renderDashboard (legacy) comparison
  it("renderDashboard returns null for empty html", () => {
    const template = { html: "", css: "body{}" };
    expect(renderDashboard(template, {}, "/*__CSS__*/", "/*__DATA__*/ {}")).toBeNull();
  });

  it("renderDashboard returns null for empty css", () => {
    const template = { html: "<html>/*__CSS__*//*__DATA__*/ {}</html>", css: "" };
    expect(renderDashboard(template, {}, "/*__CSS__*/", "/*__DATA__*/ {}")).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
// SECTION 7: Data Gathering Unit Tests
// ══════════════════════════════════════════════════════════════════

describe("gatherOverviewData", () => {
  let gatherOverviewData: typeof import("../extensions/fin-core/src/data-gathering.ts").gatherOverviewData;
  let gatherMissionControlData: typeof import("../extensions/fin-core/src/data-gathering.ts").gatherMissionControlData;
  let gatherFinanceConfigData: typeof import("../extensions/fin-core/src/data-gathering.ts").gatherFinanceConfigData;
  let gatherTradingData: typeof import("../extensions/fin-core/src/data-gathering.ts").gatherTradingData;
  let gatherCommandCenterData: typeof import("../extensions/fin-core/src/data-gathering.ts").gatherCommandCenterData;

  beforeAll(async () => {
    const mod = await import("../extensions/fin-core/src/data-gathering.ts");
    gatherOverviewData = mod.gatherOverviewData;
    gatherMissionControlData = mod.gatherMissionControlData;
    gatherFinanceConfigData = mod.gatherFinanceConfigData;
    gatherTradingData = mod.gatherTradingData;
    gatherCommandCenterData = mod.gatherCommandCenterData;
  });

  function makeMockDeps(overrides?: {
    fundState?: { allocations: unknown[]; totalCapital: number };
    strategies?: Array<{
      id: string;
      name: string;
      level: string;
      lastBacktest?: {
        totalReturn: number;
        sharpe: number;
        maxDrawdown: number;
        totalTrades: number;
      };
      status?: string;
    }>;
    accounts?: Array<{
      id: string;
      name: string;
      equity: number;
      state?: {
        equity: number;
        positions: Array<Record<string, unknown>>;
      };
      snapshots?: Array<{ timestamp: number; equity: number; dailyPnl: number }>;
      orders?: Array<Record<string, unknown>>;
    }>;
    alertCount?: number;
    eventList?: Array<Record<string, unknown>>;
    pendingCount?: number;
    exchangeList?: Array<{ id: string; name: string }>;
    pluginEntries?: Record<string, { enabled?: boolean }>;
  }) {
    const services = new Map<string, unknown>();

    const accounts = overrides?.accounts ?? [];
    services.set("fin-paper-engine", {
      listAccounts: () => accounts.map((a) => ({ id: a.id, name: a.name, equity: a.equity })),
      getAccountState: (id: string) => {
        const acct = accounts.find((a) => a.id === id);
        if (!acct?.state) {
          return null;
        }
        return {
          id: acct.id,
          name: acct.name,
          initialCapital: acct.equity,
          cash: acct.equity,
          equity: acct.state.equity,
          positions: acct.state.positions,
          orders: [],
        };
      },
      getSnapshots: (id: string) => {
        const acct = accounts.find((a) => a.id === id);
        return acct?.snapshots ?? [];
      },
      getOrders: (id: string) => {
        const acct = accounts.find((a) => a.id === id);
        return acct?.orders ?? [];
      },
    });

    services.set("fin-strategy-registry", {
      list: () => overrides?.strategies ?? [],
    });

    const alertCount = overrides?.alertCount ?? 1;
    services.set("fin-alert-engine", {
      listAlerts: () =>
        Array.from({ length: alertCount }, (_, i) => ({
          id: `a${i}`,
          symbol: "BTC/USDT",
          condition: "price_above",
        })),
    });

    if (overrides?.fundState) {
      services.set("fin-fund-manager", {
        getState: () => overrides.fundState,
      });
    }

    return {
      registry: {
        listExchanges: () => overrides?.exchangeList ?? [{ id: "binance", name: "Binance" }],
      },
      riskConfig: {
        enabled: true,
        maxAutoTradeUsd: 5000,
        confirmThresholdUsd: 1000,
        maxDailyLossUsd: 10000,
        maxPositionPct: 0.25,
        maxLeverage: 3,
        allowedPairs: ["BTC/USDT"],
        blockedPairs: [],
      },
      eventStore: {
        listEvents: () => overrides?.eventList ?? [{ id: "e1", type: "trade_executed" }],
        pendingCount: () => overrides?.pendingCount ?? 0,
      },
      runtime: { services: { get: (id: string) => services.get(id) } },
      pluginEntries: overrides?.pluginEntries ?? { "fin-core": { enabled: true } },
    } as never;
  }

  // ── gatherOverviewData ──

  it("combines mission control data with finance config", () => {
    const deps = makeMockDeps();
    const result = gatherOverviewData(deps);

    // Has all mission control fields
    expect(result).toHaveProperty("trading");
    expect(result).toHaveProperty("events");
    expect(result).toHaveProperty("alerts");
    expect(result).toHaveProperty("risk");
    expect(result).toHaveProperty("fund");

    // Has config fields (unique to overview)
    expect(result).toHaveProperty("config");
    expect(result.config).toHaveProperty("exchanges");
    expect(result.config).toHaveProperty("trading");
    expect(result.config).toHaveProperty("plugins");
  });

  it("includes trading, events, alerts, risk, fund, and config", () => {
    const deps = makeMockDeps({
      fundState: { allocations: [{ strategyId: "s1", capitalUsd: 1000 }], totalCapital: 5000 },
      alertCount: 3,
      eventList: [{ id: "e1" }, { id: "e2" }],
      pendingCount: 1,
    });
    const result = gatherOverviewData(deps);

    expect(result.trading.summary).toHaveProperty("totalEquity");
    expect(result.events.events).toHaveLength(2);
    expect(result.events.pendingCount).toBe(1);
    expect(result.alerts).toHaveLength(3);
    expect(result.risk).toHaveProperty("enabled", true);
    expect(result.risk).toHaveProperty("maxAutoTradeUsd", 5000);
    expect(result.fund).toHaveProperty("totalCapital", 5000);
    expect(result.config.exchanges).toHaveLength(1);
  });

  it("config lists correct exchange count", () => {
    const deps = makeMockDeps({
      exchangeList: [
        { id: "binance", name: "Binance" },
        { id: "coinbase", name: "Coinbase" },
        { id: "kraken", name: "Kraken" },
      ],
    });
    const result = gatherOverviewData(deps);
    expect(result.config.exchanges).toHaveLength(3);
  });

  it("config enumerates plugin status from pluginEntries", () => {
    const deps = makeMockDeps({
      pluginEntries: {
        "fin-core": { enabled: true },
        "fin-trading": { enabled: true },
        "fin-portfolio": { enabled: false },
      },
    });
    const result = gatherOverviewData(deps);
    expect(result.config.plugins.total).toBeGreaterThan(0);
    // Only fin-core and fin-trading are enabled in our pluginEntries
    expect(result.config.plugins.enabled).toBeGreaterThanOrEqual(2);
  });

  // ── gatherFinanceConfigData ──

  it("gatherFinanceConfigData returns generatedAt, exchanges, trading, plugins", () => {
    const deps = makeMockDeps();
    const result = gatherFinanceConfigData(deps);

    expect(result).toHaveProperty("generatedAt");
    expect(typeof result.generatedAt).toBe("string");
    expect(result).toHaveProperty("exchanges");
    expect(result).toHaveProperty("trading");
    expect(result.trading).toHaveProperty("enabled", true);
    expect(result.trading).toHaveProperty("maxAutoTradeUsd", 5000);
    expect(result.trading).toHaveProperty("allowedPairs");
    expect(result.trading.allowedPairs).toContain("BTC/USDT");
    expect(result).toHaveProperty("plugins");
  });

  // ── gatherTradingData ──

  it("gatherTradingData aggregates accounts into summary", () => {
    const deps = makeMockDeps({
      accounts: [
        {
          id: "acct-1",
          name: "Main",
          equity: 100000,
          state: {
            equity: 105000,
            positions: [
              {
                symbol: "BTC/USDT",
                side: "long",
                quantity: 1,
                entryPrice: 60000,
                currentPrice: 65000,
                unrealizedPnl: 5000,
              },
            ],
          },
          snapshots: [{ timestamp: Date.now(), equity: 105000, dailyPnl: 500 }],
          orders: [],
        },
      ],
    });
    const result = gatherTradingData(deps);

    expect(result.summary.totalEquity).toBe(105000);
    expect(result.positions).toHaveLength(1);
    expect(result.snapshots).toHaveLength(1);
  });

  it("gatherTradingData handles zero accounts", () => {
    const deps = makeMockDeps({ accounts: [] });
    const result = gatherTradingData(deps);

    expect(result.summary.totalEquity).toBe(0);
    expect(result.positions).toHaveLength(0);
    expect(result.orders).toHaveLength(0);
  });

  it("gatherTradingData computes win rate from paired orders", () => {
    const deps = makeMockDeps({
      accounts: [
        {
          id: "acct-1",
          name: "Main",
          equity: 10000,
          state: { equity: 10500, positions: [] },
          snapshots: [],
          orders: [
            {
              accountId: "acct-1",
              symbol: "BTC/USDT",
              side: "buy",
              fillPrice: 100,
              status: "filled",
              filledAt: 1,
            },
            {
              accountId: "acct-1",
              symbol: "BTC/USDT",
              side: "sell",
              fillPrice: 120,
              status: "filled",
              filledAt: 2,
            },
            {
              accountId: "acct-1",
              symbol: "ETH/USDT",
              side: "buy",
              fillPrice: 200,
              status: "filled",
              filledAt: 3,
            },
            {
              accountId: "acct-1",
              symbol: "ETH/USDT",
              side: "sell",
              fillPrice: 180,
              status: "filled",
              filledAt: 4,
            },
          ],
        },
      ],
    });
    const result = gatherTradingData(deps);
    // 1 win (BTC), 1 loss (ETH) → 50%
    expect(result.summary.winRate).toBe(0.5);
  });

  // ── gatherCommandCenterData ──

  it("gatherCommandCenterData returns trading + events + alerts + risk", () => {
    const deps = makeMockDeps({ alertCount: 2, eventList: [{ id: "e1" }] });
    const result = gatherCommandCenterData(deps);

    expect(result).toHaveProperty("trading");
    expect(result).toHaveProperty("events");
    expect(result.events.events).toHaveLength(1);
    expect(result).toHaveProperty("alerts");
    expect(result.alerts).toHaveLength(2);
    expect(result).toHaveProperty("risk");
  });

  // ── gatherMissionControlData ──

  it("gatherMissionControlData includes fund state", () => {
    const deps = makeMockDeps({
      fundState: { allocations: [{ strategyId: "s1", capitalUsd: 5000 }], totalCapital: 20000 },
    });
    const result = gatherMissionControlData(deps);

    expect(result).toHaveProperty("fund");
    expect(result.fund).toHaveProperty("totalCapital", 20000);
    expect(result.fund.allocations).toHaveLength(1);
  });

  it("gatherMissionControlData defaults fund when no fund manager", () => {
    const deps = makeMockDeps();
    const result = gatherMissionControlData(deps);

    expect(result.fund).toEqual({ allocations: [], totalCapital: 0 });
  });
});

describe("gatherStrategyLabData", () => {
  let gatherStrategyLabData: typeof import("../extensions/fin-core/src/data-gathering.ts").gatherStrategyLabData;

  beforeAll(async () => {
    const mod = await import("../extensions/fin-core/src/data-gathering.ts");
    gatherStrategyLabData = mod.gatherStrategyLabData;
  });

  function makeMockDeps(opts?: {
    strategies?: Array<{
      id: string;
      name: string;
      level: string;
      lastBacktest?: {
        totalReturn: number;
        sharpe: number;
        maxDrawdown: number;
        totalTrades: number;
      };
    }>;
    hasFundManager?: boolean;
    fundCapital?: number;
    fundAllocations?: Array<{ strategyId: string; capitalUsd: number }>;
  }) {
    const services = new Map<string, unknown>();
    services.set("fin-paper-engine", {
      listAccounts: () => [],
      getAccountState: () => null,
      getSnapshots: () => [],
      getOrders: () => [],
    });
    services.set("fin-strategy-registry", {
      list: () =>
        opts?.strategies ?? [
          {
            id: "s1",
            name: "Test Strategy",
            level: "L2_PAPER",
            lastBacktest: { totalReturn: 10, sharpe: 1.5, maxDrawdown: -5, totalTrades: 50 },
          },
        ],
    });
    if (opts?.hasFundManager !== false) {
      services.set("fin-fund-manager", {
        getState: () => ({
          allocations: opts?.fundAllocations ?? [{ strategyId: "s1", capitalUsd: 10000 }],
          totalCapital: opts?.fundCapital ?? 50000,
        }),
      });
    }

    return {
      registry: { listExchanges: () => [] },
      riskConfig: {
        enabled: true,
        maxAutoTradeUsd: 5000,
        confirmThresholdUsd: 1000,
        maxDailyLossUsd: 10000,
      },
      eventStore: { listEvents: () => [], pendingCount: () => 0 },
      runtime: { services: { get: (id: string) => services.get(id) } },
      pluginEntries: {},
    } as never;
  }

  it("returns strategies, backtests, allocations, fund, summary", () => {
    const deps = makeMockDeps();
    const result = gatherStrategyLabData(deps);

    expect(result).toHaveProperty("strategies");
    expect(result).toHaveProperty("backtests");
    expect(result).toHaveProperty("allocations");
    expect(result).toHaveProperty("fund");
    expect(result).toHaveProperty("summary");

    expect(result.strategies).toHaveLength(1);
    expect(result.strategies[0]).toHaveProperty("id", "s1");
    expect(result.strategies[0]).toHaveProperty("totalReturn", 10);
    expect(result.fund.totalCapital).toBe(50000);
    expect(result.summary).toHaveProperty("totalEquity");
  });

  it("includes backtests from strategies with lastBacktest", () => {
    const deps = makeMockDeps({
      strategies: [
        {
          id: "s1",
          name: "A",
          level: "L2",
          lastBacktest: { totalReturn: 15, sharpe: 2.0, maxDrawdown: -8, totalTrades: 100 },
        },
        { id: "s2", name: "B", level: "L1" }, // no backtest
      ],
    });
    const result = gatherStrategyLabData(deps);

    expect(result.strategies).toHaveLength(2);
    expect(result.backtests).toHaveLength(1);
    expect(result.backtests[0]).toHaveProperty("totalReturn", 15);
  });

  it("computes allocation totals correctly", () => {
    const deps = makeMockDeps({
      fundCapital: 100000,
      fundAllocations: [
        { strategyId: "s1", capitalUsd: 30000 },
        { strategyId: "s2", capitalUsd: 20000 },
      ],
    });
    const result = gatherStrategyLabData(deps);

    expect(result.allocations.totalAllocated).toBe(50000);
    expect(result.allocations.cashReserve).toBe(50000); // 100000 - 50000
    expect(result.allocations.totalCapital).toBe(100000);
  });

  it("handles missing fund manager gracefully", () => {
    const deps = makeMockDeps({ hasFundManager: false });
    const result = gatherStrategyLabData(deps);

    expect(result.fund).toEqual({ allocations: [], totalCapital: 0 });
    expect(result.allocations.totalCapital).toBe(0);
    expect(result.allocations.cashReserve).toBe(0);
  });

  it("handles zero strategies", () => {
    const deps = makeMockDeps({ strategies: [] });
    const result = gatherStrategyLabData(deps);

    expect(result.strategies).toHaveLength(0);
    expect(result.backtests).toHaveLength(0);
    expect(result.summary.strategyCount).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
// HTTP Server Factory
// ══════════════════════════════════════════════════════════════════

function safeReadFile(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

type UnifiedServerDeps = {
  overviewData: unknown;
  tradingDeskData: unknown;
  strategyLabData: unknown;
};

function createUnifiedServer(deps: UnifiedServerDeps) {
  const sharedCss = safeReadFile(SHARED_CSS_PATH);
  const overviewHtml = safeReadFile(OVERVIEW_HTML_PATH);
  const overviewCss = safeReadFile(OVERVIEW_CSS_PATH);
  const tradingDeskHtml = safeReadFile(TRADING_DESK_HTML_PATH);
  const tradingDeskCss = safeReadFile(TRADING_DESK_CSS_PATH);
  const strategyLabHtml = safeReadFile(STRATEGY_LAB_HTML_PATH);
  const strategyLabCss = safeReadFile(STRATEGY_LAB_CSS_PATH);

  const pages: Record<string, { html: string; css: string; data: unknown }> = {
    "/dashboard/overview": { html: overviewHtml, css: overviewCss, data: deps.overviewData },
    "/dashboard/trading-desk": {
      html: tradingDeskHtml,
      css: tradingDeskCss,
      data: deps.tradingDeskData,
    },
    "/dashboard/strategy-lab": {
      html: strategyLabHtml,
      css: strategyLabCss,
      data: deps.strategyLabData,
    },
  };

  const redirects: Record<string, string> = {
    "/dashboard/finance": "/dashboard/overview",
    "/dashboard/mission-control": "/dashboard/overview",
    "/dashboard/trading": "/dashboard/trading-desk",
    "/dashboard/command-center": "/dashboard/trading-desk",
    "/dashboard/evolution": "/dashboard/strategy-lab",
    "/dashboard/fund": "/dashboard/strategy-lab",
  };

  // JSON API endpoints (mirror real API shape)
  const apis: Record<string, unknown> = {
    "/api/v1/finance/config": deps.overviewData,
    "/api/v1/finance/trading": (deps.overviewData as Record<string, unknown>)?.trading,
    "/api/v1/finance/command-center": deps.tradingDeskData,
    "/api/v1/finance/mission-control": deps.overviewData,
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    // Redirects
    if (redirects[path]) {
      res.writeHead(302, { Location: redirects[path] });
      res.end();
      return;
    }

    // JSON API
    if (apis[path] !== undefined) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(apis[path]));
      return;
    }

    // Unified HTML pages
    const pageEntry = pages[path];
    if (pageEntry && pageEntry.html) {
      const safeJson = JSON.stringify(pageEntry.data).replace(/<\//g, "<\\/");
      const page = stripChartJsCdn(pageEntry.html)
        .replace("/*__SHARED_CSS__*/", sharedCss)
        .replace("/*__PAGE_CSS__*/", pageEntry.css)
        .replace(/\/\*__PAGE_DATA__\*\/\s*\{\}/, safeJson);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  return { server };
}

// ── Raw HTTP helper (no redirect following) ──

function rawRequest(
  urlStr: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname,
        method: "GET",
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════
// SECTION 2: Redirect Tests
// ══════════════════════════════════════════════════════════════════

describe("Unified Dashboard Redirects", () => {
  let baseUrl: string;
  let server: http.Server;

  beforeAll(async () => {
    const port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const srv = createUnifiedServer({
      overviewData: MOCK_OVERVIEW_DATA,
      tradingDeskData: MOCK_TRADING_DESK_DATA,
      strategyLabData: MOCK_STRATEGY_LAB_DATA,
    });
    server = srv.server;
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("GET /dashboard/finance redirects 302 to /dashboard/overview", async () => {
    const res = await rawRequest(`${baseUrl}/dashboard/finance`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/dashboard/overview");
  });

  it("GET /dashboard/mission-control redirects 302 to /dashboard/overview", async () => {
    const res = await rawRequest(`${baseUrl}/dashboard/mission-control`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/dashboard/overview");
  });

  it("GET /dashboard/trading redirects 302 to /dashboard/trading-desk", async () => {
    const res = await rawRequest(`${baseUrl}/dashboard/trading`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/dashboard/trading-desk");
  });

  it("GET /dashboard/command-center redirects 302 to /dashboard/trading-desk", async () => {
    const res = await rawRequest(`${baseUrl}/dashboard/command-center`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/dashboard/trading-desk");
  });

  it("GET /dashboard/evolution redirects 302 to /dashboard/strategy-lab", async () => {
    const res = await rawRequest(`${baseUrl}/dashboard/evolution`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/dashboard/strategy-lab");
  });

  it("GET /dashboard/fund redirects 302 to /dashboard/strategy-lab", async () => {
    const res = await rawRequest(`${baseUrl}/dashboard/fund`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/dashboard/strategy-lab");
  });

  it("GET /unknown returns 404", async () => {
    const res = await rawRequest(`${baseUrl}/dashboard/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("redirect body is empty (no content leaked)", async () => {
    const res = await rawRequest(`${baseUrl}/dashboard/finance`);
    expect(res.body).toBe("");
  });
});

// ══════════════════════════════════════════════════════════════════
// SECTIONS 1,3,4,5: Route + HTML Content + Data Injection + CSS Injection Tests
// (requires HTML files to exist)
// ══════════════════════════════════════════════════════════════════

describe.skipIf(!hasAllUnifiedHtml)("Unified Dashboard Route & Content Tests", () => {
  let baseUrl: string;
  let server: http.Server;

  beforeAll(async () => {
    const port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const srv = createUnifiedServer({
      overviewData: MOCK_OVERVIEW_DATA,
      tradingDeskData: MOCK_TRADING_DESK_DATA,
      strategyLabData: MOCK_STRATEGY_LAB_DATA,
    });
    server = srv.server;
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // ── Section 1: Route Tests ──

  describe("Routes return 200 HTML", () => {
    it("GET /dashboard/overview returns 200 text/html", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/overview`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
    });

    it("GET /dashboard/trading-desk returns 200 text/html", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/trading-desk`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
    });

    it("GET /dashboard/strategy-lab returns 200 text/html", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/strategy-lab`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
    });
  });

  // ── Section 4: Data Injection Tests ──

  describe("PAGE_DATA injection", () => {
    it("overview HTML contains injected totalEquity", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/overview`);
      expect(res.body).toContain("125430");
    });

    it("overview HTML contains injected strategy names", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/overview`);
      expect(res.body).toContain("Alpha Momentum");
      expect(res.body).toContain("Beta Mean Reversion");
    });

    it("overview HTML has __PAGE_DATA__ placeholder replaced", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/overview`);
      expect(res.body).not.toContain("/*__PAGE_DATA__*/ {}");
    });

    it("trading-desk HTML contains injected position data", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/trading-desk`);
      expect(res.body).toContain("BTC/USDT");
      expect(res.body).toContain("ETH/USDT");
    });

    it("trading-desk HTML contains event data", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/trading-desk`);
      expect(res.body).toContain("BUY 0.5 BTC/USDT");
    });

    it("strategy-lab HTML contains strategy data", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/strategy-lab`);
      expect(res.body).toContain("Alpha Momentum");
    });

    it("strategy-lab HTML contains allocation data", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/strategy-lab`);
      expect(res.body).toContain("75000"); // totalAllocated
    });

    it("data with </ sequences is properly escaped in all pages", async () => {
      const xssPort = await getFreePort();
      const xssSrv = createUnifiedServer({
        overviewData: XSS_STRATEGY_DATA,
        tradingDeskData: { ...MOCK_TRADING_DESK_DATA, trading: XSS_STRATEGY_DATA.trading },
        strategyLabData: {
          ...MOCK_STRATEGY_LAB_DATA,
          strategies: XSS_STRATEGY_DATA.trading.strategies,
        },
      });
      await new Promise<void>((r) => xssSrv.server.listen(xssPort, "127.0.0.1", r));

      try {
        const res = await rawRequest(`http://127.0.0.1:${xssPort}/dashboard/overview`);
        // The literal </script> should NOT appear unescaped
        expect(res.body).not.toMatch(/<\/script><script>alert/);
      } finally {
        xssSrv.server.close();
      }
    });
  });

  // ── Section 5: CSS Injection Tests ──

  describe("CSS injection", () => {
    it("overview HTML contains shared CSS variables (--bg, --gain, --loss)", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/overview`);
      expect(res.body).toContain("--bg:");
      expect(res.body).toContain("--gain:");
      expect(res.body).toContain("--loss:");
    });

    it("overview HTML has __SHARED_CSS__ placeholder replaced", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/overview`);
      expect(res.body).not.toContain("/*__SHARED_CSS__*/");
    });

    it("overview HTML has __PAGE_CSS__ placeholder replaced", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/overview`);
      expect(res.body).not.toContain("/*__PAGE_CSS__*/");
    });

    it("overview page CSS contains .config-status", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/overview`);
      expect(res.body).toContain(".config-status");
    });

    it("trading-desk page CSS contains .pos-detail-row", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/trading-desk`);
      expect(res.body).toContain(".pos-detail-row");
    });

    it("trading-desk page CSS contains .buying-power", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/trading-desk`);
      expect(res.body).toContain(".buying-power");
    });

    it("strategy-lab page CSS contains .tier-bars", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/strategy-lab`);
      expect(res.body).toContain(".tier-bars");
    });

    it("strategy-lab page CSS contains .tier-bar-fill", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/strategy-lab`);
      expect(res.body).toContain(".tier-bar-fill");
    });

    it("shared CSS includes strategy pipeline level tokens (--l0, --l3)", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/overview`);
      expect(res.body).toContain("--l0:");
      expect(res.body).toContain("--l3:");
    });
  });

  // ── Section 3: HTML Content Structure Tests ──

  describe("HTML structure", () => {
    it("overview HTML includes DOCTYPE and lang attribute", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/overview`);
      expect(res.body).toMatch(/<!doctype html>/i);
      expect(res.body).toContain('lang="zh-CN"');
    });

    it("overview HTML has correct page title", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/overview`);
      expect(res.body).toContain("<title>OpenFinClaw");
    });

    it("overview HTML contains topbar with OPENFINCLAW logo", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/overview`);
      expect(res.body).toContain("OPENFINCLAW");
      expect(res.body).toContain("topbar");
    });

    it("overview HTML contains equity elements (eqVal, eqMiniVal)", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/overview`);
      expect(res.body).toContain('id="eqVal"');
      expect(res.body).toContain('id="eqMiniVal"');
    });

    it("overview HTML contains stat pills section", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/overview`);
      expect(res.body).toContain('id="statPills"');
      expect(res.body).toContain("stat-pill");
      expect(res.body).toContain('id="spPositions"');
      expect(res.body).toContain('id="spStrategies"');
      expect(res.body).toContain('id="spWinRate"');
      expect(res.body).toContain('id="spAvgSharpe"');
    });

    it("overview HTML contains risk badge", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/overview`);
      expect(res.body).toContain('id="riskBadge"');
      expect(res.body).toContain('id="riskStatus"');
    });

    it("overview HTML contains equity chart canvas", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/overview`);
      expect(res.body).toContain('id="equityChart"');
    });

    it("overview HTML contains AI fab button", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/overview`);
      expect(res.body).toContain('id="aiFab"');
      expect(res.body).toContain("ai-fab");
    });

    it("overview HTML contains emergency stop button", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/overview`);
      expect(res.body).toContain('id="estopBtn"');
      expect(res.body).toContain("STOP");
    });

    it("overview HTML contains clock element", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/overview`);
      expect(res.body).toContain('id="clock"');
    });

    it("trading-desk HTML has correct page title", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/trading-desk`);
      expect(res.body).toContain("<title>OpenFinClaw");
      expect(res.body).toContain("Trading Desk");
    });

    it("trading-desk HTML contains position list section", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/trading-desk`);
      expect(res.body).toContain('id="positionsList"');
    });

    it("trading-desk HTML contains buying power section", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/trading-desk`);
      expect(res.body).toContain("buying-power");
      expect(res.body).toContain('id="bpVal"');
    });

    it("trading-desk HTML contains order history section", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/trading-desk`);
      expect(res.body).toContain('id="orderHistBody"');
    });

    it("trading-desk HTML contains strategy raceboard", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/trading-desk`);
      expect(res.body).toContain('id="raceBody"');
    });

    it("trading-desk HTML contains event feed", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/trading-desk`);
      expect(res.body).toContain('id="feedList"');
    });

    it("trading-desk HTML contains pending section", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/trading-desk`);
      expect(res.body).toContain('id="pendingSection"');
      expect(res.body).toContain('id="pendingList"');
    });

    it("strategy-lab HTML has correct page title", async () => {
      const res = await rawRequest(`${baseUrl}/dashboard/strategy-lab`);
      expect(res.body).toContain("<title>OpenFinClaw");
    });
  });

  // ── JSON API Tests ──

  describe("JSON API endpoints", () => {
    it("GET /api/v1/finance/config returns config JSON", async () => {
      const { status, body } = await fetchJson(`${baseUrl}/api/v1/finance/config`);
      expect(status).toBe(200);
      const data = body as Record<string, unknown>;
      expect(data).toHaveProperty("config");
    });

    it("GET /api/v1/finance/trading returns trading data", async () => {
      const { status, body } = await fetchJson(`${baseUrl}/api/v1/finance/trading`);
      expect(status).toBe(200);
      const data = body as Record<string, unknown>;
      expect(data).toHaveProperty("summary");
    });

    it("GET unknown API path returns 404", async () => {
      const { status } = await fetchJson(`${baseUrl}/api/v1/finance/nope`);
      expect(status).toBe(404);
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// Playwright Browser Tests
// ══════════════════════════════════════════════════════════════════

const E2E_TIMEOUT = 60_000;

describe.skipIf(!hasBrowser || !hasAllUnifiedHtml)("Unified Dashboard Playwright E2E", () => {
  let browser: Awaited<ReturnType<NonNullable<typeof chromium>["launch"]>> | undefined;
  let baseUrl: string;
  let server: http.Server;

  beforeAll(async () => {
    if (!chromium) {
      return;
    }
    const port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const srv = createUnifiedServer({
      overviewData: MOCK_OVERVIEW_DATA,
      tradingDeskData: MOCK_TRADING_DESK_DATA,
      strategyLabData: MOCK_STRATEGY_LAB_DATA,
    });
    server = srv.server;
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    browser = await chromium.launch({ executablePath: browserPath, headless: true });
  }, E2E_TIMEOUT);

  afterAll(async () => {
    await browser?.close();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function openPage(path: string) {
    const page = await browser!.newPage();
    await page.goto(`${baseUrl}${path}`, { waitUntil: "load", timeout: 30000 });
    // Wait for inline script to populate DOM from pageData
    await page.waitForFunction(
      () => {
        const el = document.getElementById("eqVal") || document.getElementById("eqMiniVal");
        return el && el.textContent !== "--" && el.textContent !== "";
      },
      { timeout: 15000 },
    );
    return page;
  }

  // ── Overview page ──

  it("Overview: topbar shows equity value", { timeout: E2E_TIMEOUT }, async () => {
    const page = await openPage("/dashboard/overview");
    const eqVal = await page.locator("#eqVal").textContent();
    expect(eqVal).toContain("125");
    await page.close();
  });

  it(
    "Overview: stat pills show position count from positions array",
    { timeout: E2E_TIMEOUT },
    async () => {
      const page = await openPage("/dashboard/overview");
      const posCount = await page.locator("#spPositions").textContent();
      // JS renders positions.length (3 in mock data), not summary.positionCount
      expect(posCount).toBe("3");
      await page.close();
    },
  );

  it(
    "Overview: stat pills show strategy count from strategies array",
    { timeout: E2E_TIMEOUT },
    async () => {
      const page = await openPage("/dashboard/overview");
      const stratCount = await page.locator("#spStrategies").textContent();
      // JS renders strategies.length (3 in mock data), not summary.strategyCount
      expect(stratCount).toBe("3");
      await page.close();
    },
  );

  it("Overview: stat pills show avg sharpe from strategies", { timeout: E2E_TIMEOUT }, async () => {
    const page = await openPage("/dashboard/overview");
    const avgSharpe = await page.locator("#spAvgSharpe").textContent();
    // avgSharpe = (2.1 + 1.4 + 0.9) / 3 = 1.47
    expect(avgSharpe).toContain("1.47");
    await page.close();
  });

  it("Overview: risk badge is rendered", { timeout: E2E_TIMEOUT }, async () => {
    const page = await openPage("/dashboard/overview");
    const riskBadge = await page.locator("#riskBadge").textContent();
    expect(riskBadge).toBeTruthy();
    await page.close();
  });

  it("Overview: equity chart canvas exists and is visible", { timeout: E2E_TIMEOUT }, async () => {
    const page = await openPage("/dashboard/overview");
    const canvas = page.locator("#equityChart");
    expect(await canvas.count()).toBe(1);
    await page.close();
  });

  it("Overview: AI fab button is visible", { timeout: E2E_TIMEOUT }, async () => {
    const page = await openPage("/dashboard/overview");
    const fab = page.locator("#aiFab");
    expect(await fab.count()).toBe(1);
    const text = await fab.textContent();
    expect(text).toContain("FinClaw");
    await page.close();
  });

  it("Overview: emergency stop button present", { timeout: E2E_TIMEOUT }, async () => {
    const page = await openPage("/dashboard/overview");
    const estop = page.locator("#estopBtn");
    expect(await estop.count()).toBe(1);
    expect(await estop.textContent()).toContain("STOP");
    await page.close();
  });

  it("Overview: dark theme background color applied", { timeout: E2E_TIMEOUT }, async () => {
    const page = await openPage("/dashboard/overview");
    const bgColor = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    // --bg: #0b0d12 = rgb(11, 13, 18)
    expect(bgColor).toBe("rgb(11, 13, 18)");
    await page.close();
  });

  it("Overview: clock element has time format", { timeout: E2E_TIMEOUT }, async () => {
    const page = await openPage("/dashboard/overview");
    const clock = await page.locator("#clock").textContent();
    // Should show HH:MM format
    expect(clock).toMatch(/\d{1,2}:\d{2}/);
    await page.close();
  });

  // ── Trading desk page ──

  it("Trading desk: topbar shows equity", { timeout: E2E_TIMEOUT }, async () => {
    const page = await openPage("/dashboard/trading-desk");
    const eqVal = await page.locator("#eqVal").textContent();
    expect(eqVal).toContain("125");
    await page.close();
  });

  it("Trading desk: positions list is populated", { timeout: E2E_TIMEOUT }, async () => {
    const page = await openPage("/dashboard/trading-desk");
    const body = await page.locator("#positionsList").textContent();
    expect(body).toContain("BTC");
    await page.close();
  });

  it("Trading desk: buying power value is shown", { timeout: E2E_TIMEOUT }, async () => {
    const page = await openPage("/dashboard/trading-desk");
    const bpVal = await page.locator("#bpVal").textContent();
    expect(bpVal).not.toBe("--");
    await page.close();
  });

  it("Trading desk: strategy raceboard contains strategies", { timeout: E2E_TIMEOUT }, async () => {
    const page = await openPage("/dashboard/trading-desk");
    const raceRows = await page.locator("#raceBody tr").count();
    expect(raceRows).toBeGreaterThanOrEqual(1);
    await page.close();
  });

  it("Trading desk: event feed is populated", { timeout: E2E_TIMEOUT }, async () => {
    const page = await openPage("/dashboard/trading-desk");
    const feedHtml = await page.locator("#feedList").innerHTML();
    // Feed should contain event titles
    expect(feedHtml.length).toBeGreaterThan(0);
    await page.close();
  });

  it(
    "Trading desk: has navigation with active Trading link",
    { timeout: E2E_TIMEOUT },
    async () => {
      const page = await openPage("/dashboard/trading-desk");
      const activeNav = page.locator(".topbar__nav-item.active");
      const text = await activeNav.textContent();
      expect(text).toContain("Trading");
      await page.close();
    },
  );

  // ── Strategy lab page ──

  it("Strategy lab: page renders without errors", { timeout: E2E_TIMEOUT }, async () => {
    const page = await browser!.newPage();
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto(`${baseUrl}/dashboard/strategy-lab`, {
      waitUntil: "load",
      timeout: 30000,
    });
    await page.waitForTimeout(2000);
    // Filter out Chart.js CDN errors (stripped for testing)
    const realErrors = errors.filter((e) => !e.includes("Chart"));
    expect(realErrors).toHaveLength(0);
    await page.close();
  });

  it("Strategy lab: body text contains strategy names", { timeout: E2E_TIMEOUT }, async () => {
    const page = await browser!.newPage();
    await page.goto(`${baseUrl}/dashboard/strategy-lab`, {
      waitUntil: "load",
      timeout: 30000,
    });
    await page.waitForTimeout(2000);
    const body = await page.locator("body").textContent();
    expect(body).toContain("Alpha Momentum");
    await page.close();
  });

  // ── Edge cases ──

  it("Edge: empty data renders without JS errors", { timeout: E2E_TIMEOUT }, async () => {
    const edgePort = await getFreePort();
    const edgeSrv = createUnifiedServer({
      overviewData: EMPTY_OVERVIEW_DATA,
      tradingDeskData: {
        trading: EMPTY_OVERVIEW_DATA.trading,
        events: EMPTY_OVERVIEW_DATA.events,
        alerts: EMPTY_OVERVIEW_DATA.alerts,
        risk: EMPTY_OVERVIEW_DATA.risk,
      },
      strategyLabData: {
        strategies: [],
        backtests: [],
        allocations: EMPTY_OVERVIEW_DATA.trading.allocations,
        fund: EMPTY_OVERVIEW_DATA.fund,
        summary: EMPTY_OVERVIEW_DATA.trading.summary,
      },
    });
    await new Promise<void>((r) => edgeSrv.server.listen(edgePort, "127.0.0.1", r));

    try {
      const page = await browser!.newPage();
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));
      await page.goto(`http://127.0.0.1:${edgePort}/dashboard/overview`, {
        waitUntil: "load",
        timeout: 30000,
      });
      await page.waitForTimeout(3000);
      const realErrors = errors.filter((e) => !e.includes("Chart"));
      expect(realErrors).toHaveLength(0);
      await page.close();
    } finally {
      edgeSrv.server.close();
    }
  });

  it("Edge: negative PnL has loss styling", { timeout: E2E_TIMEOUT }, async () => {
    const negPort = await getFreePort();
    const negSrv = createUnifiedServer({
      overviewData: NEGATIVE_PNL_DATA,
      tradingDeskData: {
        trading: NEGATIVE_PNL_DATA.trading,
        events: NEGATIVE_PNL_DATA.events,
        alerts: NEGATIVE_PNL_DATA.alerts,
        risk: NEGATIVE_PNL_DATA.risk,
      },
      strategyLabData: MOCK_STRATEGY_LAB_DATA,
    });
    await new Promise<void>((r) => negSrv.server.listen(negPort, "127.0.0.1", r));

    try {
      const page = await browser!.newPage();
      await page.goto(`http://127.0.0.1:${negPort}/dashboard/overview`, {
        waitUntil: "load",
        timeout: 30000,
      });
      await page.waitForTimeout(3000);

      // The PnL change element should show negative indicator
      const eqChg = page.locator("#eqChg, #eqMiniChg").first();
      const text = await eqChg.textContent();
      const classes = (await eqChg.getAttribute("class")) ?? "";
      const hasNeg = text?.includes("-") || classes.includes("loss");
      expect(hasNeg).toBe(true);

      await page.close();
    } finally {
      negSrv.server.close();
    }
  });

  it("Edge: XSS in strategy name does not fire alert", { timeout: E2E_TIMEOUT }, async () => {
    const xssPort = await getFreePort();
    const xssSrv = createUnifiedServer({
      overviewData: XSS_STRATEGY_DATA,
      tradingDeskData: {
        trading: XSS_STRATEGY_DATA.trading,
        events: XSS_STRATEGY_DATA.events,
        alerts: XSS_STRATEGY_DATA.alerts,
        risk: XSS_STRATEGY_DATA.risk,
      },
      strategyLabData: {
        strategies: XSS_STRATEGY_DATA.trading.strategies,
        backtests: [],
        allocations: XSS_STRATEGY_DATA.trading.allocations,
        fund: XSS_STRATEGY_DATA.fund,
        summary: XSS_STRATEGY_DATA.trading.summary,
      },
    });
    await new Promise<void>((r) => xssSrv.server.listen(xssPort, "127.0.0.1", r));

    try {
      const page = await browser!.newPage();
      let alertFired = false;
      page.on("dialog", () => {
        alertFired = true;
      });
      await page.goto(`http://127.0.0.1:${xssPort}/dashboard/overview`, {
        waitUntil: "load",
        timeout: 30000,
      });
      await page.waitForTimeout(3000);
      expect(alertFired).toBe(false);
      await page.close();
    } finally {
      xssSrv.server.close();
    }
  });
});
