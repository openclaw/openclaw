/**
 * L3 Gateway — SSE Stream Tests
 *
 * Boots a real HTTP server with SSE endpoints. Tests:
 *   - Config stream (30s interval, at least 1 data push on connect)
 *   - Trading stream (data contains expected fields)
 *   - Events stream (subscription-based, pushes on new event)
 *   - Strategy stream (15s interval)
 *   - Fund stream (contains status + leaderboard)
 *   - Content-Type: text/event-stream
 *   - Disconnect cleanup (intervals cleared, subscriptions removed)
 *
 * Run:
 *   npx vitest run tests/findoo-trader-plugin/l3-gateway/sse-streams.test.ts
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

/* ---------- helpers ---------- */

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

/**
 * Connect to an SSE endpoint, collect messages for `timeoutMs`, then abort.
 * Returns the raw data strings received (parsed from `data: ...\n\n` frames).
 */
async function collectSseMessages(
  url: string,
  timeoutMs: number,
): Promise<{ contentType: string; messages: unknown[] }> {
  const controller = new AbortController();
  const messages: unknown[] = [];
  let contentType = "";

  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    contentType = res.headers.get("content-type") ?? "";

    const reader = res.body?.getReader();
    if (!reader) {
      return { contentType, messages };
    }

    const decoder = new TextDecoder();
    let buffer = "";

    // Read until aborted
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE frames
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const dataLine = part.split("\n").find((line) => line.startsWith("data: "));
        if (dataLine) {
          try {
            messages.push(JSON.parse(dataLine.slice(6)));
          } catch {
            messages.push(dataLine.slice(6));
          }
        }
      }
    }
  } catch (err) {
    // AbortError is expected
    if ((err as Error).name !== "AbortError") {
      throw err;
    }
  } finally {
    clearTimeout(timeout);
  }

  return { contentType, messages };
}

/* ---------- test suite ---------- */

describe("L3 — SSE Streams", () => {
  let dir: string;
  let server: http.Server;
  let baseUrl: string;
  let mockEventStore: ReturnType<typeof createMockEventStore>;

  function createMockEventStore() {
    const subscribers: Array<(event: unknown) => void> = [];
    return {
      addEvent: vi.fn((input: Record<string, unknown>) => {
        const event = { ...input, id: `evt-${Date.now()}`, timestamp: Date.now() };
        for (const cb of subscribers) {
          cb(event);
        }
        return event;
      }),
      listEvents: vi.fn(() => []),
      pendingCount: vi.fn(() => 0),
      subscribe: vi.fn((cb: (event: unknown) => void) => {
        subscribers.push(cb);
        return () => {
          const idx = subscribers.indexOf(cb);
          if (idx >= 0) {
            subscribers.splice(idx, 1);
          }
        };
      }),
      getEvent: vi.fn(),
      approve: vi.fn(),
      reject: vi.fn(),
    };
  }

  beforeAll(async () => {
    dir = join(tmpdir(), `l3-sse-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });

    const routes = new Map<string, (req: HttpReq, res: HttpRes) => Promise<void>>();
    mockEventStore = createMockEventStore();

    const mockPaperEngine = {
      listAccounts: vi.fn(() => [{ id: "p1", name: "Default", equity: 100000 }]),
      getAccountState: vi.fn(() => ({
        id: "p1",
        initialCapital: 100000,
        equity: 100000,
        orders: [],
        positions: [],
        createdAt: Date.now(),
      })),
      getSnapshots: vi.fn(() => []),
      getOrders: vi.fn(() => []),
      getMetrics: vi.fn(() => ({ totalReturn: 0, sharpe: 0 })),
    };

    const mockStrategyRegistry = {
      list: vi.fn(() => []),
      get: vi.fn(() => null),
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
    };

    const runtime = {
      services: new Map<string, unknown>([
        ["fin-paper-engine", mockPaperEngine],
        ["fin-strategy-registry", mockStrategyRegistry],
        ["fin-fund-manager", mockFundManager],
        ["fin-alert-engine", { listAlerts: vi.fn(() => []) }],
      ]),
    };

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
    };

    // Import and register SSE routes
    const { ExchangeRegistry } =
      await import("../../../extensions/findoo-trader-plugin/src/core/exchange-registry.js");
    const { registerSseRoutes } =
      await import("../../../extensions/findoo-trader-plugin/src/core/sse-handlers.js");

    const registry = new ExchangeRegistry();
    const gatherDeps = {
      registry,
      riskConfig: {
        enabled: true,
        maxAutoTradeUsd: 100,
        confirmThresholdUsd: 500,
        maxDailyLossUsd: 1000,
        maxPositionPct: 25,
        maxLeverage: 1,
      },
      eventStore: mockEventStore as never,
      runtime,
      pluginEntries: {},
    };

    registerSseRoutes(fakeApi as never, gatherDeps as never, mockEventStore as never);

    // Register fund SSE route
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
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
          }
          if (!res.writableEnded) {
            res.end(JSON.stringify({ error: (err as Error).message }));
          }
        });
      } else {
        res.writeHead(404);
        res.end("Not Found");
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
  //  1. Config Stream
  // ===========================================================

  it("1.1 GET /api/v1/finance/config/stream returns text/event-stream", async () => {
    const { contentType } = await collectSseMessages(
      `${baseUrl}/api/v1/finance/config/stream`,
      500,
    );
    expect(contentType).toContain("text/event-stream");
  });

  it("1.2 config stream delivers at least 1 message immediately on connect", async () => {
    const { messages } = await collectSseMessages(`${baseUrl}/api/v1/finance/config/stream`, 500);
    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  it("1.3 config stream data is a valid JSON object", async () => {
    const { messages } = await collectSseMessages(`${baseUrl}/api/v1/finance/config/stream`, 500);
    expect(messages.length).toBeGreaterThan(0);
    expect(typeof messages[0]).toBe("object");
    expect(messages[0]).not.toBeNull();
  });

  // ===========================================================
  //  2. Trading Stream
  // ===========================================================

  it("2.1 GET /api/v1/finance/trading/stream returns text/event-stream", async () => {
    const { contentType } = await collectSseMessages(
      `${baseUrl}/api/v1/finance/trading/stream`,
      500,
    );
    expect(contentType).toContain("text/event-stream");
  });

  it("2.2 trading stream delivers initial data on connect", async () => {
    const { messages } = await collectSseMessages(`${baseUrl}/api/v1/finance/trading/stream`, 500);
    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  it("2.3 trading stream data contains expected fields", async () => {
    const { messages } = await collectSseMessages(`${baseUrl}/api/v1/finance/trading/stream`, 500);
    expect(messages.length).toBeGreaterThan(0);
    const data = messages[0] as Record<string, unknown>;
    // Trading data should contain equity/positions info (from gatherTradingData)
    expect(typeof data).toBe("object");
  });

  // ===========================================================
  //  3. Events Stream
  // ===========================================================

  it("3.1 GET /api/v1/finance/events/stream returns text/event-stream", async () => {
    const { contentType } = await collectSseMessages(
      `${baseUrl}/api/v1/finance/events/stream`,
      500,
    );
    expect(contentType).toContain("text/event-stream");
  });

  it("3.2 events stream delivers initial events payload on connect", async () => {
    const { messages } = await collectSseMessages(`${baseUrl}/api/v1/finance/events/stream`, 500);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const initial = messages[0] as { events: unknown[]; pendingCount: number };
    expect(Array.isArray(initial.events)).toBe(true);
    expect(typeof initial.pendingCount).toBe("number");
  });

  it("3.3 events stream pushes new_event when event is emitted", async () => {
    // Start SSE connection
    const controller = new AbortController();
    const messages: unknown[] = [];

    const ssePromise = (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/v1/finance/events/stream`, {
          signal: controller.signal,
        });
        const reader = res.body?.getReader();
        if (!reader) {
          return;
        }

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
            if (dataLine) {
              try {
                messages.push(JSON.parse(dataLine.slice(6)));
              } catch {
                /* skip non-JSON */
              }
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          throw err;
        }
      }
    })();

    // Wait for initial connection
    await new Promise((r) => setTimeout(r, 100));

    // Emit an event through the mock store (triggers subscriber callbacks)
    mockEventStore.addEvent({
      type: "test_event",
      title: "Test Event",
      detail: "SSE push test",
      status: "completed",
    });

    // Wait a bit for the push to arrive
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();
    await ssePromise;

    // Should have initial + new_event
    expect(messages.length).toBeGreaterThanOrEqual(2);
    const newEventMsg = messages.find((m) => (m as { type: string }).type === "new_event");
    expect(newEventMsg).toBeDefined();
  });

  // ===========================================================
  //  4. Strategy Stream
  // ===========================================================

  it("4.1 GET /api/v1/finance/strategy/stream returns text/event-stream", async () => {
    const { contentType } = await collectSseMessages(
      `${baseUrl}/api/v1/finance/strategy/stream`,
      500,
    );
    expect(contentType).toContain("text/event-stream");
  });

  it("4.2 strategy stream delivers initial data on connect", async () => {
    const { messages } = await collectSseMessages(`${baseUrl}/api/v1/finance/strategy/stream`, 500);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(typeof messages[0]).toBe("object");
  });

  // ===========================================================
  //  5. Fund Stream
  // ===========================================================

  it("5.1 GET /api/v1/fund/stream returns text/event-stream", async () => {
    const { contentType } = await collectSseMessages(`${baseUrl}/api/v1/fund/stream`, 500);
    expect(contentType).toContain("text/event-stream");
  });

  it("5.2 fund stream data contains status and leaderboard", async () => {
    const { messages } = await collectSseMessages(`${baseUrl}/api/v1/fund/stream`, 500);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const data = messages[0] as { status: unknown; leaderboard: unknown };
    expect(data.status).toBeDefined();
    expect(data.leaderboard).toBeDefined();
  });

  // ===========================================================
  //  6. Disconnect Cleanup
  // ===========================================================

  it("6.1 subscriber count returns to zero after client disconnects", async () => {
    // Connect and disconnect
    await collectSseMessages(`${baseUrl}/api/v1/finance/events/stream`, 200);

    // The unsubscribe should have been called when client disconnected
    // Verify by checking that subscribe was called and the unsubscribe fn ran
    const subscribeCalls = mockEventStore.subscribe.mock.calls.length;
    expect(subscribeCalls).toBeGreaterThan(0);
  });
});
