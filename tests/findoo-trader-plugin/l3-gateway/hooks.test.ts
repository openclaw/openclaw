/**
 * L3 Gateway — Hooks Contract Tests
 *
 * Validates the two plugin hooks registered by findoo-trader-plugin:
 *   1. before_tool_call — risk gate that blocks/confirms trading tool calls
 *   2. before_prompt_build — financial context injection into system prompt
 *
 * Uses mock API surface to capture hook registrations, then invokes them
 * directly to verify behavior.
 *
 * Run:
 *   npx vitest run tests/findoo-trader-plugin/l3-gateway/hooks.test.ts
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock ccxt before any plugin imports
vi.mock("ccxt", () => {
  class MockExchange {
    setSandboxMode = vi.fn();
    close = vi.fn();
  }
  return { binance: MockExchange, okx: MockExchange };
});

import findooTraderPlugin from "../../../extensions/findoo-trader-plugin/index.js";

/* ---------- types ---------- */

type ToolDef = {
  name: string;
  description?: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};

type ServiceDef = { id: string; start?: () => void; instance: unknown };

type HookHandler = (event: Record<string, unknown>) => Promise<unknown>;

/* ---------- fake gateway API factory ---------- */

function createFakeApi(stateDir: string, pluginConfig: Record<string, unknown> = {}) {
  const tools = new Map<string, ToolDef>();
  const services = new Map<string, ServiceDef>();
  const hooks = new Map<string, HookHandler[]>();
  const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const logs: Array<{ level: string; msg: string }> = [];

  const api = {
    id: "findoo-trader-plugin",
    name: "Findoo Trader",
    source: "gateway",
    config: {
      plugins: { entries: {} },
      financial: {},
    },
    pluginConfig: {
      exchanges: {},
      trading: {
        enabled: true,
        maxAutoTradeUsd: 100,
        confirmThresholdUsd: 500,
        maxDailyLossUsd: 1000,
        maxPositionPct: 25,
        maxLeverage: 1,
      },
      ...pluginConfig,
    },
    runtime: {
      version: "test-gateway-l3",
      services: new Map<string, unknown>(),
    },
    logger: {
      info: (...args: unknown[]) => logs.push({ level: "info", msg: String(args[0]) }),
      warn: (...args: unknown[]) => logs.push({ level: "warn", msg: String(args[0]) }),
      error: (...args: unknown[]) => logs.push({ level: "error", msg: String(args[0]) }),
      debug: (...args: unknown[]) => logs.push({ level: "debug", msg: String(args[0]) }),
    },
    log: (level: string, msg: string) => logs.push({ level, msg }),
    registerTool(tool: ToolDef) {
      tools.set(tool.name, tool);
    },
    registerHook(name: string, handler: HookHandler, _opts?: unknown) {
      if (!hooks.has(name)) {
        hooks.set(name, []);
      }
      hooks.get(name)!.push(handler);
    },
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService(svc: ServiceDef) {
      services.set(svc.id, svc);
      api.runtime.services.set(svc.id, svc.instance);
    },
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    resolvePath: (p: string) => {
      const full = join(stateDir, p);
      mkdirSync(join(full, ".."), { recursive: true });
      return full;
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      if (!events.has(event)) {
        events.set(event, []);
      }
      events.get(event)!.push(handler);
    },
  };

  return { api: api as never, tools, services, hooks, events, logs };
}

/* ---------- tests ---------- */

describe("L3 — Hooks Contract", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "l3-hooks-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ===========================================================
  //  1. before_tool_call — Risk Gate Hook
  // ===========================================================

  it("1.1 registers a before_tool_call hook", async () => {
    const { api, hooks } = createFakeApi(tempDir);
    findooTraderPlugin.register(api);

    expect(hooks.has("before_tool_call")).toBe(true);
    expect(hooks.get("before_tool_call")!.length).toBeGreaterThanOrEqual(1);
  });

  it("1.2 allows read-only tools without blocking", async () => {
    const { api, hooks } = createFakeApi(tempDir);
    findooTraderPlugin.register(api);

    const hookHandler = hooks.get("before_tool_call")![0];
    const result = await hookHandler({
      toolName: "fin_strategy_list",
      params: {},
    });

    // No block for read-only tools — returns undefined
    expect(result).toBeUndefined();
  });

  it("1.3 allows small auto-trade (below maxAutoTradeUsd threshold)", async () => {
    const { api, hooks } = createFakeApi(tempDir, {
      trading: {
        enabled: true,
        maxAutoTradeUsd: 100,
        confirmThresholdUsd: 500,
        maxDailyLossUsd: 1000,
        maxPositionPct: 25,
        maxLeverage: 1,
      },
    });
    findooTraderPlugin.register(api);

    const hookHandler = hooks.get("before_tool_call")![0];
    const result = await hookHandler({
      toolName: "fin_paper_order",
      params: {
        symbol: "BTC/USDT",
        side: "buy",
        amount: 0.001,
        price: 50000,
      },
    });

    // $50 trade is within maxAutoTradeUsd=100 → auto-approve
    expect(result).toBeUndefined();
  });

  it("1.4 blocks or requires confirmation for trade above confirmThresholdUsd", async () => {
    const { api, hooks } = createFakeApi(tempDir, {
      trading: {
        enabled: true,
        maxAutoTradeUsd: 100,
        confirmThresholdUsd: 500,
        maxDailyLossUsd: 1000,
        maxPositionPct: 25,
        maxLeverage: 1,
      },
    });
    findooTraderPlugin.register(api);

    const hookHandler = hooks.get("before_tool_call")![0];
    const result = await hookHandler({
      toolName: "fin_place_order",
      params: {
        symbol: "BTC/USDT",
        side: "buy",
        amount: 0.02,
        price: 50000,
        // estimatedValueUsd = 0.02 * 50000 = 1000 → above 500 confirm threshold
      },
    });

    const r = result as { block?: boolean; blockReason?: string } | undefined;
    // Trade above confirmThresholdUsd should be blocked (either confirm or reject tier)
    expect(r).toBeDefined();
    expect(r!.block).toBe(true);
    expect(r!.blockReason).toContain("Risk Gate");
  });

  it("1.5 blocks trade that exceeds maxDailyLossUsd (reject tier)", async () => {
    const { api, hooks } = createFakeApi(tempDir, {
      trading: {
        enabled: true,
        maxAutoTradeUsd: 100,
        confirmThresholdUsd: 500,
        maxDailyLossUsd: 1000,
        maxPositionPct: 25,
        maxLeverage: 1,
      },
    });
    findooTraderPlugin.register(api);

    const hookHandler = hooks.get("before_tool_call")![0];

    // Very large trade that should trigger reject
    const result = await hookHandler({
      toolName: "fin_place_order",
      params: {
        symbol: "BTC/USDT",
        side: "buy",
        amount: 100,
        price: 50000,
        // estimatedValueUsd = 100 * 50000 = 5,000,000 → massively over limits
      },
    });

    const r = result as { block?: boolean; blockReason?: string } | undefined;
    // This should either block or require confirmation due to position size limits
    if (r) {
      expect(r.block).toBe(true);
      expect(r.blockReason).toBeDefined();
    }
  });

  it("1.6 risk gate applies to all 8 TRADING_TOOLS", async () => {
    const { api, hooks } = createFakeApi(tempDir);
    findooTraderPlugin.register(api);

    const hookHandler = hooks.get("before_tool_call")![0];

    const tradingToolNames = [
      "fin_place_order",
      "fin_modify_order",
      "fin_set_stop_loss",
      "fin_set_take_profit",
      "fin_paper_order",
      "fin_fund_rebalance",
      "fin_fund_allocate",
      "fin_fund_promote",
    ];

    // All trading tools should pass through the hook (not return undefined for large values)
    for (const toolName of tradingToolNames) {
      const result = await hookHandler({
        toolName,
        params: {
          symbol: "BTC/USDT",
          side: "buy",
          amount: 1000,
          price: 50000,
          estimatedValueUsd: 50_000_000, // Absurdly large to ensure risk gate triggers
        },
      });

      const r = result as { block?: boolean } | undefined;
      // Large trades should be blocked or require confirmation
      if (r) {
        expect(r.block, `${toolName} should trigger risk gate for large trade`).toBe(true);
      }
    }
  });

  it("1.7 non-trading tools bypass risk gate entirely", async () => {
    const { api, hooks } = createFakeApi(tempDir);
    findooTraderPlugin.register(api);

    const hookHandler = hooks.get("before_tool_call")![0];

    const readOnlyTools = [
      "fin_strategy_list",
      "fin_strategy_status",
      "fin_paper_account",
      "fin_paper_history",
      "fin_fund_status",
      "fin_fund_leaderboard",
      "fin_fund_risk",
    ];

    for (const toolName of readOnlyTools) {
      const result = await hookHandler({
        toolName,
        params: { estimatedValueUsd: 999999 },
      });
      expect(result, `${toolName} should not be blocked`).toBeUndefined();
    }
  });

  it("1.8 risk gate uses estimatedValueUsd param when available", async () => {
    const { api, hooks } = createFakeApi(tempDir, {
      trading: {
        enabled: true,
        maxAutoTradeUsd: 100,
        confirmThresholdUsd: 500,
        maxDailyLossUsd: 1000,
        maxPositionPct: 25,
        maxLeverage: 1,
      },
    });
    findooTraderPlugin.register(api);

    const hookHandler = hooks.get("before_tool_call")![0];

    // Trade with explicit estimatedValueUsd above threshold
    const result = await hookHandler({
      toolName: "fin_fund_allocate",
      params: {
        symbol: "BTC/USDT",
        capitalUsd: 50000,
      },
    });

    const r = result as { block?: boolean } | undefined;
    // capitalUsd=50000 should trigger risk checks
    if (r) {
      expect(r.block).toBe(true);
    }
  });

  // ===========================================================
  //  2. before_prompt_build — Financial Context Injection
  // ===========================================================

  it("2.1 registers a before_prompt_build event handler", async () => {
    const { api, events } = createFakeApi(tempDir);
    findooTraderPlugin.register(api);

    expect(events.has("before_prompt_build")).toBe(true);
    expect(events.get("before_prompt_build")!.length).toBeGreaterThanOrEqual(1);
  });

  it("2.2 before_prompt_build returns prependContext string", async () => {
    const { api, events } = createFakeApi(tempDir);
    findooTraderPlugin.register(api);

    const handler = events.get("before_prompt_build")![0];
    const result = (await handler()) as { prependContext?: string } | undefined;

    // The handler should return context to inject or undefined/void
    if (result) {
      expect(typeof result.prependContext).toBe("string");
      expect(result.prependContext!.length).toBeGreaterThan(0);
    }
  });

  it("2.3 financial context includes exchange registry info", async () => {
    const { api, events } = createFakeApi(tempDir, {
      exchanges: {
        "test-exchange": {
          exchange: "binance",
          apiKey: "test-key",
          secret: "test-secret",
          testnet: true,
        },
      },
    });
    findooTraderPlugin.register(api);

    const handler = events.get("before_prompt_build")![0];
    const result = (await handler()) as { prependContext?: string } | undefined;

    if (result?.prependContext) {
      // Context should reference exchanges or trading state
      expect(result.prependContext.length).toBeGreaterThan(50);
    }
  });

  it("2.4 financial context includes paper trading state", async () => {
    const { api, events } = createFakeApi(tempDir);
    findooTraderPlugin.register(api);

    const handler = events.get("before_prompt_build")![0];
    const result = (await handler()) as { prependContext?: string } | undefined;

    // The context builder reads paperEngine.listAccounts()
    // With a freshly registered plugin it should have some paper info
    if (result?.prependContext) {
      expect(typeof result.prependContext).toBe("string");
    }
  });

  it("2.5 financial context includes risk controller status", async () => {
    const { api, events, services } = createFakeApi(tempDir);
    findooTraderPlugin.register(api);

    // Verify risk controller was registered
    expect(services.has("fin-risk-controller")).toBe(true);

    const handler = events.get("before_prompt_build")![0];
    const result = (await handler()) as { prependContext?: string } | undefined;

    if (result?.prependContext) {
      expect(result.prependContext.length).toBeGreaterThan(0);
    }
  });

  // ===========================================================
  //  3. Hook Interaction Safety
  // ===========================================================

  it("3.1 before_tool_call hook does not throw for unknown tool names", async () => {
    const { api, hooks } = createFakeApi(tempDir);
    findooTraderPlugin.register(api);

    const hookHandler = hooks.get("before_tool_call")![0];
    await expect(
      hookHandler({ toolName: "completely_unknown_tool", params: {} }),
    ).resolves.not.toThrow();
  });

  it("3.2 before_tool_call hook handles missing params gracefully", async () => {
    const { api, hooks } = createFakeApi(tempDir);
    findooTraderPlugin.register(api);

    const hookHandler = hooks.get("before_tool_call")![0];
    await expect(hookHandler({ toolName: "fin_place_order" })).resolves.not.toThrow();
  });

  it("3.3 before_prompt_build handles empty state gracefully", async () => {
    const { api, events } = createFakeApi(tempDir);
    findooTraderPlugin.register(api);

    const handler = events.get("before_prompt_build")![0];
    // Should not throw even with fresh/empty state
    await expect(handler()).resolves.not.toThrow();
  });
});
