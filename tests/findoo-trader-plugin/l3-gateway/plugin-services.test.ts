/**
 * L3 Gateway — Plugin Services Contract Tests
 *
 * Validates findoo-trader-plugin register() boots all services, tools, and skills
 * in a simulated gateway environment (mock API surface, no real exchange).
 *
 * Covers:
 *   1. register() creates all expected services in runtime.services
 *   2. Config schema validation (exchanges, trading.enabled, trading.maxAutoTradeUsd)
 *   3. Tool registration (23 AI tools across 4 modules)
 *   4. Skill directory integrity (8 skills from ./skills)
 *   5. Plugin metadata matches openclaw.plugin.json
 *
 * Run:
 *   npx vitest run tests/findoo-trader-plugin/l3-gateway/plugin-services.test.ts
 */

import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import findooTraderPlugin from "../../../extensions/findoo-trader-plugin/index.js";
import { resolveConfig } from "../../../extensions/findoo-trader-plugin/src/config.js";

/* ---------- types ---------- */

type ToolDef = {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  handler?: (...args: unknown[]) => Promise<unknown>;
  execute?: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};

type ServiceDef = { id: string; start?: () => void; instance: unknown };

/* ---------- fake gateway API factory ---------- */

function createFakeApi(stateDir: string, pluginConfig: Record<string, unknown> = {}) {
  const tools = new Map<string, ToolDef>();
  const services = new Map<string, ServiceDef>();
  const hooks = new Map<string, unknown[]>();
  const events = new Map<string, unknown[]>();
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
      trading: { enabled: false, maxAutoTradeUsd: 100, confirmThresholdUsd: 500 },
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
    registerHook(name: string, handler: unknown, _opts?: unknown) {
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
    on(event: string, handler: unknown) {
      if (!events.has(event)) {
        events.set(event, []);
      }
      events.get(event)!.push(handler);
    },
  };

  return { api: api as never, tools, services, hooks, events, logs };
}

/* ---------- tests ---------- */

// Mock ccxt to prevent real exchange connections
vi.mock("ccxt", () => {
  class MockExchange {
    setSandboxMode = vi.fn();
    close = vi.fn();
  }
  return { binance: MockExchange, okx: MockExchange };
});

describe("L3 — Plugin Services Contract", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "l3-trader-svc-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ===========================================================
  //  1. Service Registration
  // ===========================================================

  it("1.1 register() completes without throwing", () => {
    const { api } = createFakeApi(tempDir);
    expect(() => findooTraderPlugin.register(api)).not.toThrow();
  });

  it("1.2 registers all 8 core runtime services", async () => {
    const { api, services } = createFakeApi(tempDir);
    findooTraderPlugin.register(api);

    const expectedServices = [
      "fin-exchange-registry",
      "fin-risk-controller",
      "fin-event-store",
      "fin-alert-engine",
      "fin-exchange-health-store",
      "fin-live-executor",
      "fin-paper-engine",
      "fin-strategy-registry",
    ];
    for (const svcId of expectedServices) {
      expect(services.has(svcId), `Missing service: ${svcId}`).toBe(true);
    }
  });

  it("1.3 registers additional infrastructure services (agent-config, gate-config, activity-log, fund-manager)", async () => {
    const { api, services } = createFakeApi(tempDir);
    findooTraderPlugin.register(api);

    const additionalServices = [
      "fin-agent-config",
      "fin-gate-config",
      "fin-activity-log",
      "fin-fund-manager",
    ];
    for (const svcId of additionalServices) {
      expect(services.has(svcId), `Missing additional service: ${svcId}`).toBe(true);
    }
  });

  it("1.4 fin-exchange-registry exposes addExchange and listExchanges", async () => {
    const { api, services } = createFakeApi(tempDir);
    findooTraderPlugin.register(api);

    const registry = services.get("fin-exchange-registry")!.instance as Record<string, unknown>;
    expect(typeof registry.addExchange).toBe("function");
    expect(typeof registry.listExchanges).toBe("function");
  });

  it("1.5 fin-risk-controller exposes evaluate and updateConfig", async () => {
    const { api, services } = createFakeApi(tempDir);
    findooTraderPlugin.register(api);

    const risk = services.get("fin-risk-controller")!.instance as Record<string, unknown>;
    expect(typeof risk.evaluate).toBe("function");
    expect(typeof risk.updateConfig).toBe("function");
  });

  it("1.6 fin-paper-engine exposes listAccounts and submitOrder", async () => {
    const { api, services } = createFakeApi(tempDir);
    findooTraderPlugin.register(api);

    const paper = services.get("fin-paper-engine")!.instance as Record<string, unknown>;
    expect(typeof paper.listAccounts).toBe("function");
    expect(typeof paper.submitOrder).toBe("function");
  });

  it("1.7 fin-strategy-registry exposes list and create methods", async () => {
    const { api, services } = createFakeApi(tempDir);
    findooTraderPlugin.register(api);

    const registry = services.get("fin-strategy-registry")!.instance as Record<string, unknown>;
    expect(typeof registry.list).toBe("function");
    expect(typeof registry.create).toBe("function");
  });

  it("1.8 fin-fund-manager exposes getState and evaluateRisk", async () => {
    const { api, services } = createFakeApi(tempDir);
    findooTraderPlugin.register(api);

    const fund = services.get("fin-fund-manager")!.instance as Record<string, unknown>;
    expect(typeof fund.getState).toBe("function");
    expect(typeof fund.evaluateRisk).toBe("function");
  });

  // ===========================================================
  //  2. Config Schema Validation
  // ===========================================================

  it("2.1 resolveConfig returns defaults when no config provided", () => {
    const fakeApi = {
      pluginConfig: {},
      config: {},
      resolvePath: (p: string) => join(tempDir, p),
    } as never;

    const config = resolveConfig(fakeApi);

    expect(config.riskConfig.enabled).toBe(false);
    expect(config.riskConfig.maxAutoTradeUsd).toBe(100);
    expect(config.riskConfig.confirmThresholdUsd).toBe(500);
    expect(config.riskConfig.maxDailyLossUsd).toBe(1000);
    expect(config.riskConfig.maxPositionPct).toBe(25);
    expect(config.riskConfig.maxLeverage).toBe(1);
  });

  it("2.2 resolveConfig picks up pluginConfig.trading overrides", () => {
    const fakeApi = {
      pluginConfig: {
        trading: {
          enabled: true,
          maxAutoTradeUsd: 500,
          confirmThresholdUsd: 2000,
        },
      },
      config: {},
      resolvePath: (p: string) => join(tempDir, p),
    } as never;

    const config = resolveConfig(fakeApi);

    expect(config.riskConfig.enabled).toBe(true);
    expect(config.riskConfig.maxAutoTradeUsd).toBe(500);
    expect(config.riskConfig.confirmThresholdUsd).toBe(2000);
  });

  it("2.3 resolveConfig returns empty exchanges by default", () => {
    const fakeApi = {
      pluginConfig: {},
      config: {},
      resolvePath: (p: string) => join(tempDir, p),
    } as never;

    const config = resolveConfig(fakeApi);
    expect(config.exchanges).toEqual({});
  });

  it("2.4 resolveConfig.exchanges is an object (matches configSchema)", () => {
    const fakeApi = {
      pluginConfig: {
        exchanges: { "test-exchange": { exchange: "binance", apiKey: "k", secret: "s" } },
      },
      config: {},
      resolvePath: (p: string) => join(tempDir, p),
    } as never;

    const config = resolveConfig(fakeApi);
    expect(typeof config.exchanges).toBe("object");
    expect(config.exchanges["test-exchange"]).toBeDefined();
  });

  it("2.5 configSchema in openclaw.plugin.json declares correct types", () => {
    const pluginJsonPath = resolve(
      __dirname,
      "../../../extensions/findoo-trader-plugin/openclaw.plugin.json",
    );
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pluginJson = require(pluginJsonPath);

    expect(pluginJson.configSchema.type).toBe("object");
    expect(pluginJson.configSchema.properties.exchanges.type).toBe("object");
    expect(pluginJson.configSchema.properties.trading.type).toBe("object");
    expect(pluginJson.configSchema.properties.trading.properties.enabled.type).toBe("boolean");
    expect(pluginJson.configSchema.properties.trading.properties.maxAutoTradeUsd.type).toBe(
      "number",
    );
  });

  // ===========================================================
  //  3. Tool Registration
  // ===========================================================

  it("3.1 registers exactly 30 AI tools (5 trading + 6 paper + 5 strategy + 9 fund + 5 index)", async () => {
    const { api, tools } = createFakeApi(tempDir);
    findooTraderPlugin.register(api);
    expect(tools.size).toBe(30);
  });

  it("3.2 all tool names match specification", async () => {
    const { api, tools } = createFakeApi(tempDir);
    findooTraderPlugin.register(api);

    // 5 trading tools
    const tradingTools = [
      "fin_place_order",
      "fin_modify_order",
      "fin_cancel_order",
      "fin_set_stop_loss",
      "fin_set_take_profit",
    ];

    // 6 paper tools
    const paperTools = [
      "fin_paper_create",
      "fin_paper_order",
      "fin_paper_positions",
      "fin_paper_state",
      "fin_paper_metrics",
      "fin_paper_list",
    ];

    // 5 strategy tools
    const strategyTools = [
      "fin_strategy_create",
      "fin_strategy_list",
      "fin_backtest_run",
      "fin_backtest_result",
      "fin_walk_forward_run",
    ];

    // 9 fund tools
    const fundTools = [
      "fin_fund_status",
      "fin_fund_allocate",
      "fin_fund_rebalance",
      "fin_leaderboard",
      "fin_fund_promote",
      "fin_fund_risk",
      "fin_list_promotions_ready",
      "fin_strategy_tick",
      "fin_lifecycle_scan",
    ];

    // 5 index-level tools (alpha factory, cron, ideation, evolution)
    const indexTools = [
      "fin_alpha_factory_run",
      "fin_alpha_factory_status",
      "fin_cron_setup",
      "fin_ideation_trigger",
      "fin_evolution_scan",
    ];

    const allExpected = [
      ...tradingTools,
      ...paperTools,
      ...strategyTools,
      ...fundTools,
      ...indexTools,
    ];

    for (const name of allExpected) {
      expect(tools.has(name), `Missing tool: ${name}`).toBe(true);
    }
  });

  it("3.3 each tool has name, description (>10 chars), and handler function", async () => {
    const { api, tools } = createFakeApi(tempDir);
    findooTraderPlugin.register(api);

    for (const [name, tool] of tools) {
      expect(typeof tool.name, `${name}.name`).toBe("string");
      expect(typeof tool.description, `${name}.description`).toBe("string");
      expect(tool.description!.length, `${name}.description length`).toBeGreaterThan(10);
      const hasFn = typeof tool.handler === "function" || typeof tool.execute === "function";
      expect(hasFn, `${name} must have handler or execute function`).toBe(true);
    }
  });

  it("3.4 multiple register() calls do not leak tools or services", async () => {
    const ctx1 = createFakeApi(tempDir);
    findooTraderPlugin.register(ctx1.api);
    const toolCount1 = ctx1.tools.size;

    const tempDir2 = mkdtempSync(join(tmpdir(), "l3-trader-svc2-"));
    const ctx2 = createFakeApi(tempDir2);
    findooTraderPlugin.register(ctx2.api);

    expect(ctx1.tools.size).toBe(toolCount1);
    expect(ctx2.tools.size).toBe(toolCount1);

    rmSync(tempDir2, { recursive: true, force: true });
  });

  // ===========================================================
  //  4. Skills
  // ===========================================================

  it("4.1 skills directory exists and contains 8 skill directories", () => {
    const skillsDir = resolve(__dirname, "../../../extensions/findoo-trader-plugin/skills");
    expect(existsSync(skillsDir)).toBe(true);

    const entries = readdirSync(skillsDir, { withFileTypes: true });
    const skillDirs = entries.filter((e) => e.isDirectory() && e.name !== "node_modules");
    expect(skillDirs.length).toBe(8);
  });

  it("4.2 each skill directory contains a skill.md file", () => {
    const skillsDir = resolve(__dirname, "../../../extensions/findoo-trader-plugin/skills");
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    const skillDirs = entries.filter((e) => e.isDirectory() && e.name !== "node_modules");

    for (const dir of skillDirs) {
      const skillMd = join(skillsDir, dir.name, "skill.md");
      expect(existsSync(skillMd), `Missing skill.md in ${dir.name}`).toBe(true);
    }
  });

  it("4.3 openclaw.plugin.json declares skills path", () => {
    const pluginJsonPath = resolve(
      __dirname,
      "../../../extensions/findoo-trader-plugin/openclaw.plugin.json",
    );
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pluginJson = require(pluginJsonPath);
    expect(pluginJson.skills).toBeDefined();
    expect(pluginJson.skills).toContain("./skills");
  });

  // ===========================================================
  //  5. Plugin Metadata
  // ===========================================================

  it("5.1 plugin metadata matches openclaw.plugin.json", () => {
    expect(findooTraderPlugin.id).toBe("findoo-trader-plugin");
    expect(findooTraderPlugin.name).toBe("Findoo Trader");
    expect(findooTraderPlugin.kind).toBe("financial");
  });

  it("5.2 SQLite state files are created during registration", async () => {
    const { api } = createFakeApi(tempDir);
    findooTraderPlugin.register(api);

    // Key SQLite files created by services
    const expectedFiles = [
      "state/findoo-events.sqlite",
      "state/findoo-alerts.sqlite",
      "state/findoo-paper.sqlite",
      "state/findoo-activity-log.sqlite",
      "state/findoo-exchange-health.sqlite",
    ];
    for (const file of expectedFiles) {
      expect(existsSync(join(tempDir, file)), `Missing state file: ${file}`).toBe(true);
    }
  });
});
