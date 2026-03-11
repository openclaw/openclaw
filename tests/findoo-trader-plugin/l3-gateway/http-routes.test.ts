/**
 * L3 Gateway — HTTP Route Completeness Tests
 *
 * Boots a real HTTP server with the plugin's route handlers wired to mock
 * services. Tests the full network roundtrip: HTTP client -> server -> route
 * handler -> service -> response.
 *
 * Covers:
 *   - Dashboard HTML pages (overview, trader, strategy, setting, flow)
 *   - API data endpoints (config, trading, dashboard/strategy)
 *   - Order placement + cancellation
 *   - OHLCV K-line data
 *   - Fund endpoints (status, leaderboard, risk, allocations)
 *   - Alert creation
 *   - Emergency stop
 *   - 404 for unknown routes
 *
 * Run:
 *   npx vitest run tests/findoo-trader-plugin/l3-gateway/http-routes.test.ts
 */

import { mkdirSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Mock ccxt before any plugin imports
vi.mock("ccxt", () => {
  class MockExchange {
    setSandboxMode = vi.fn();
    close = vi.fn();
  }
  return { binance: MockExchange, okx: MockExchange };
});

import type { HttpReq, HttpRes } from "../../../extensions/findoo-trader-plugin/src/types-http.js";

/* ---------- HTTP helpers ---------- */

async function getFreePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address();
  if (!addr || typeof addr === "string") {
    throw new Error("failed to bind port");
  }
  const port = addr.port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

async function fetchJson(
  url: string,
  opts?: RequestInit,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await fetch(url, opts);
  let body: unknown;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("json")) {
    body = await res.json();
  } else {
    body = await res.text();
  }
  return { status: res.status, body, headers: res.headers };
}

/* ---------- test suite ---------- */

describe("L3 — HTTP Route Completeness", () => {
  let dir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    dir = join(tmpdir(), `l3-routes-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });

    // Capture routes from plugin registration
    const routes = new Map<string, (req: HttpReq, res: HttpRes) => Promise<void>>();

    const mockEventStore = {
      addEvent: vi.fn((input: Record<string, unknown>) => ({
        ...input,
        id: `evt-${Date.now()}`,
        timestamp: Date.now(),
      })),
      listEvents: vi.fn(() => []),
      pendingCount: vi.fn(() => 0),
      getEvent: vi.fn(),
      approve: vi.fn(),
      reject: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    };

    const mockPaperEngine = {
      listAccounts: vi.fn(() => [{ id: "paper-1", name: "Default", equity: 100000 }]),
      getAccountState: vi.fn(() => ({
        id: "paper-1",
        initialCapital: 100000,
        equity: 100000,
        orders: [],
        positions: [],
        createdAt: Date.now(),
      })),
      submitOrder: vi.fn((_acctId: string, order: Record<string, unknown>) => ({
        id: `ord-${Date.now()}`,
        status: "filled",
        ...order,
      })),
      getSnapshots: vi.fn(() => []),
      getOrders: vi.fn(() => []),
      getMetrics: vi.fn(() => ({ totalReturn: 0, sharpe: 0 })),
    };

    const mockStrategyRegistry = {
      list: vi.fn(() => []),
      get: vi.fn(() => null),
      register: vi.fn(),
      updateStatus: vi.fn(),
      updateLevel: vi.fn(),
    };

    const mockAlertEngine = {
      listAlerts: vi.fn(() => []),
      addAlert: vi.fn(() => `alert-${Date.now()}`),
      removeAlert: vi.fn(() => true),
    };

    const mockFundManager = {
      getState: vi.fn(() => ({
        totalCapital: 100000,
        allocations: [],
        lastRebalanceAt: null,
      })),
      evaluateRisk: vi.fn(() => ({
        riskLevel: "normal",
        todayPnl: 0,
        todayPnlPct: 0,
        dailyDrawdown: 0,
        maxAllowedDrawdown: -0.1,
      })),
      buildProfiles: vi.fn(() => []),
      getLeaderboard: vi.fn(() => []),
      riskManager: { getScaleFactor: vi.fn(() => 1) },
      markDayStart: vi.fn(),
    };

    const mockDataProvider = {
      getOHLCV: vi.fn(async () => [[Date.now(), 50000, 51000, 49000, 50500, 1000]]),
    };

    const runtime = {
      services: new Map<string, unknown>([
        ["fin-paper-engine", mockPaperEngine],
        ["fin-strategy-registry", mockStrategyRegistry],
        ["fin-alert-engine", mockAlertEngine],
        ["fin-fund-manager", mockFundManager],
        ["fin-data-provider", mockDataProvider],
      ]),
    };

    // Import and register route modules
    const { registerHttpRoutes } =
      await import("../../../extensions/findoo-trader-plugin/src/core/route-handlers.js");
    const { ExchangeRegistry } =
      await import("../../../extensions/findoo-trader-plugin/src/core/exchange-registry.js");
    const { RiskController } =
      await import("../../../extensions/findoo-trader-plugin/src/core/risk-controller.js");
    const { ExchangeHealthStore } =
      await import("../../../extensions/findoo-trader-plugin/src/core/exchange-health-store.js");

    const registry = new ExchangeRegistry();
    const riskController = new RiskController({
      enabled: true,
      maxAutoTradeUsd: 100,
      confirmThresholdUsd: 500,
      maxDailyLossUsd: 1000,
      maxPositionPct: 25,
      maxLeverage: 1,
    });
    const healthStore = new ExchangeHealthStore(join(dir, "health.sqlite"));

    const fakeApi = {
      registerHttpRoute({
        path,
        handler,
      }: {
        path: string;
        handler: (req: HttpReq, res: HttpRes) => Promise<void>;
      }) {
        routes.set(path, handler);
      },
      registerCommand: vi.fn(),
      registerCli: vi.fn(),
      pluginConfig: {},
    };

    registerHttpRoutes({
      api: fakeApi as never,
      gatherDeps: {
        registry,
        riskConfig: riskController.getConfig(),
        eventStore: mockEventStore as never,
        runtime,
        pluginEntries: {},
        liveExecutor: undefined,
      },
      eventStore: mockEventStore as never,
      healthStore,
      riskController,
      runtime,
      templates: { overview: "", trader: "", strategy: "", setting: "", flow: "" },
      registry,
    });

    // Register alert routes
    const { registerAlertRoutes } =
      await import("../../../extensions/findoo-trader-plugin/src/core/routes-alerts.js");
    registerAlertRoutes(fakeApi as never, runtime, mockEventStore as never);

    // Register strategy routes
    const { registerStrategyRoutes } =
      await import("../../../extensions/findoo-trader-plugin/src/core/routes-strategies.js");
    registerStrategyRoutes(fakeApi as never, runtime, mockEventStore as never);

    // Register fund routes
    const { registerFundRoutes } =
      await import("../../../extensions/findoo-trader-plugin/src/fund/routes.js");
    const { PerformanceSnapshotStore } =
      await import("../../../extensions/findoo-trader-plugin/src/fund/performance-snapshot-store.js");
    const { CapitalFlowStore } =
      await import("../../../extensions/findoo-trader-plugin/src/fund/capital-flow-store.js");

    const perfStore = new PerformanceSnapshotStore(join(dir, "perf.sqlite"));
    const flowStore = new CapitalFlowStore(join(dir, "flows.sqlite"));

    registerFundRoutes(fakeApi as never, {
      manager: mockFundManager as never,
      config: {
        totalCapital: 100000,
        cashReservePct: 30,
        maxSingleStrategyPct: 30,
        maxTotalExposurePct: 70,
        rebalanceFrequency: "weekly",
      },
      flowStore,
      perfStore,
      getRegistry: () => mockStrategyRegistry as never,
      getPaper: () => mockPaperEngine as never,
    });

    // Boot real HTTP server
    const port = await getFreePort();
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      const handler = routes.get(url.pathname);
      if (handler) {
        handler(req as unknown as HttpReq, res as unknown as HttpRes).catch((err) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
        });
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not Found" }));
      }
    });

    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  // ===========================================================
  //  1. Dashboard HTML Pages
  // ===========================================================

  it("1.1 GET /plugins/findoo-trader/dashboard/overview returns 200", async () => {
    const { status } = await fetchJson(`${baseUrl}/plugins/findoo-trader/dashboard/overview`);
    expect(status).toBe(200);
  });

  it("1.2 GET /plugins/findoo-trader/dashboard/trader returns 200", async () => {
    const { status } = await fetchJson(`${baseUrl}/plugins/findoo-trader/dashboard/trader`);
    expect(status).toBe(200);
  });

  it("1.3 GET /plugins/findoo-trader/dashboard/strategy returns 200", async () => {
    const { status } = await fetchJson(`${baseUrl}/plugins/findoo-trader/dashboard/strategy`);
    expect(status).toBe(200);
  });

  it("1.4 GET /plugins/findoo-trader/dashboard/setting returns 200", async () => {
    const { status } = await fetchJson(`${baseUrl}/plugins/findoo-trader/dashboard/setting`);
    expect(status).toBe(200);
  });

  it("1.5 GET /plugins/findoo-trader/dashboard/flow returns 200", async () => {
    const { status } = await fetchJson(`${baseUrl}/plugins/findoo-trader/dashboard/flow`);
    expect(status).toBe(200);
  });

  // ===========================================================
  //  2. API Data Endpoints
  // ===========================================================

  it("2.1 GET /api/v1/finance/config returns 200 JSON", async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/v1/finance/config`);
    expect(status).toBe(200);
    expect(body).toBeDefined();
    expect(typeof body).toBe("object");
  });

  it("2.2 GET /api/v1/finance/trading returns 200 JSON", async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/v1/finance/trading`);
    expect(status).toBe(200);
    expect(typeof body).toBe("object");
  });

  it("2.3 GET /api/v1/finance/dashboard/strategy returns 200 JSON", async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/v1/finance/dashboard/strategy`);
    expect(status).toBe(200);
    expect(typeof body).toBe("object");
  });

  // ===========================================================
  //  3. Order Operations
  // ===========================================================

  it("3.1 POST /api/v1/finance/orders with valid body returns 201", async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/v1/finance/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 0.001,
        domain: "paper",
      }),
    });
    // 201 (filled) or 202 (pending approval) depending on risk config
    expect([200, 201, 202]).toContain(status);
    expect(body).toBeDefined();
  });

  it("3.2 POST /api/v1/finance/orders with invalid body returns 400", async () => {
    const { status } = await fetchJson(`${baseUrl}/api/v1/finance/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(status).toBe(400);
  });

  it("3.3 POST /api/v1/finance/orders/cancel with orderId returns 200", async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/v1/finance/orders/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: "test-order-123" }),
    });
    expect(status).toBe(200);
    expect((body as { status: string }).status).toBe("cancelled");
  });

  // ===========================================================
  //  4. OHLCV K-line Data
  // ===========================================================

  it("4.1 GET /api/v1/finance/ohlcv?symbol=BTC/USD returns 200 JSON", async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/v1/finance/ohlcv?symbol=BTC/USD`);
    expect(status).toBe(200);
    const data = body as { symbol: string; candles: unknown[] };
    expect(data.symbol).toBe("BTC/USD");
    expect(Array.isArray(data.candles)).toBe(true);
  });

  it("4.2 GET /api/v1/finance/ohlcv without symbol returns 400", async () => {
    const { status } = await fetchJson(`${baseUrl}/api/v1/finance/ohlcv`);
    expect(status).toBe(400);
  });

  // ===========================================================
  //  5. Fund Endpoints
  // ===========================================================

  it("5.1 GET /api/v1/fund/status returns 200 JSON", async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/v1/fund/status`);
    expect(status).toBe(200);
    const data = body as { totalEquity: number };
    expect(typeof data.totalEquity).toBe("number");
  });

  it("5.2 GET /api/v1/fund/leaderboard returns 200 JSON", async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/v1/fund/leaderboard`);
    expect(status).toBe(200);
    expect((body as { leaderboard: unknown[] }).leaderboard).toBeDefined();
  });

  it("5.3 GET /api/v1/fund/risk returns 200 JSON", async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/v1/fund/risk`);
    expect(status).toBe(200);
    const data = body as { riskLevel: string };
    expect(data.riskLevel).toBeDefined();
  });

  it("5.4 GET /api/v1/fund/allocations returns 200 JSON", async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/v1/fund/allocations`);
    expect(status).toBe(200);
    const data = body as { allocations: unknown[]; totalCapital: number };
    expect(Array.isArray(data.allocations)).toBe(true);
    expect(typeof data.totalCapital).toBe("number");
  });

  // ===========================================================
  //  6. Alert Operations
  // ===========================================================

  it("6.1 POST /api/v1/finance/alerts/create returns 201", async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/v1/finance/alerts/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "price_above",
        symbol: "BTC/USDT",
        threshold: 60000,
      }),
    });
    expect([200, 201]).toContain(status);
    expect(body).toBeDefined();
  });

  // ===========================================================
  //  7. Emergency Stop
  // ===========================================================

  it("7.1 POST /api/v1/finance/emergency-stop returns 200 with stopped status", async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/v1/finance/emergency-stop`, {
      method: "POST",
    });
    expect(status).toBe(200);
    const data = body as { status: string; tradingDisabled: boolean };
    expect(data.status).toBe("stopped");
    expect(data.tradingDisabled).toBe(true);
  });

  // ===========================================================
  //  8. 404 for Unknown Routes
  // ===========================================================

  it("8.1 GET /api/v1/finance/xxx returns 404", async () => {
    const { status } = await fetchJson(`${baseUrl}/api/v1/finance/xxx`);
    expect(status).toBe(404);
  });
});
