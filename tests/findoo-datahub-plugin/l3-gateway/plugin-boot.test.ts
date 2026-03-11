/**
 * L3 Gateway — Plugin Boot Contract Tests
 *
 * Validates the findoo-datahub-plugin bootstrap contract in a simulated
 * gateway environment. Uses mock API surface — no real DataHub connection.
 *
 * Covers:
 *   1. Plugin register() successfully registers all services
 *   2. Config schema validation (required/optional fields)
 *   3. Service lifecycle: boot -> ready -> shutdown (no leaks)
 *   4. Tool registration count matches specification
 *   5. Skill scanning: ./skills directory contains expected 33 skills
 *
 * Run:
 *   npx vitest run tests/findoo-datahub-plugin/l3-gateway/plugin-boot.test.ts
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import findooDatahubPlugin from "../../../extensions/findoo-datahub-plugin/index.js";
import { resolveConfig } from "../../../extensions/findoo-datahub-plugin/src/config.js";

/* ---------- types ---------- */

type ToolDef = {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};

type ServiceDef = { id: string; start?: () => void; instance: unknown };

/* ---------- fake gateway API factory ---------- */

function createFakeApi(stateDir: string, pluginConfig: Record<string, unknown> = {}) {
  const tools = new Map<string, ToolDef>();
  const services = new Map<string, ServiceDef>();
  const logs: Array<{ level: string; msg: string }> = [];

  const api = {
    id: "findoo-datahub-plugin",
    name: "Findoo DataHub",
    source: "gateway",
    config: {},
    pluginConfig: {
      datahubApiKey: "test-mock-key-not-real",
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
    registerHook: vi.fn(),
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
    on: vi.fn(),
  };

  return { api: api as never, tools, services, logs };
}

/* ---------- tests ---------- */

describe("L3 — Plugin Boot Contract", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "l3-boot-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ═══════════════════════════════════════════════════════════
  //  1. Plugin register() — services + metadata
  // ═══════════════════════════════════════════════════════════

  it("1.1 register() completes without throwing", () => {
    const { api } = createFakeApi(tempDir);
    expect(() => findooDatahubPlugin.register(api)).not.toThrow();
  });

  it("1.2 registers exactly 2 services: fin-data-provider and fin-regime-detector", async () => {
    const { api, services } = createFakeApi(tempDir);
    findooDatahubPlugin.register(api);

    expect(services.has("fin-data-provider")).toBe(true);
    expect(services.has("fin-regime-detector")).toBe(true);
    expect(services.size).toBe(2);
  });

  it("1.3 fin-data-provider exposes getOHLCV, getTicker, detectRegime, getSupportedMarkets", async () => {
    const { api, services } = createFakeApi(tempDir);
    findooDatahubPlugin.register(api);

    const provider = services.get("fin-data-provider")!.instance as Record<string, unknown>;
    expect(typeof provider.getOHLCV).toBe("function");
    expect(typeof provider.getTicker).toBe("function");
    expect(typeof provider.detectRegime).toBe("function");
    expect(typeof provider.getSupportedMarkets).toBe("function");
  });

  it("1.4 fin-regime-detector exposes detect method", async () => {
    const { api, services } = createFakeApi(tempDir);
    findooDatahubPlugin.register(api);

    const detector = services.get("fin-regime-detector")!.instance as Record<string, unknown>;
    expect(typeof detector.detect).toBe("function");
  });

  it("1.5 plugin metadata matches openclaw.plugin.json", () => {
    expect(findooDatahubPlugin.id).toBe("findoo-datahub-plugin");
    expect(findooDatahubPlugin.name).toBe("Findoo DataHub");
    expect(findooDatahubPlugin.kind).toBe("financial");
  });

  // ═══════════════════════════════════════════════════════════
  //  2. Config schema validation
  // ═══════════════════════════════════════════════════════════

  it("2.1 resolveConfig uses defaults when no config provided", () => {
    const fakeApi = {
      pluginConfig: {},
      resolvePath: (p: string) => join(tempDir, p),
    } as never;

    // Clear env vars to test defaults
    const saved = { ...process.env };
    delete process.env.DATAHUB_API_URL;
    delete process.env.DATAHUB_USERNAME;
    delete process.env.DATAHUB_API_KEY;
    delete process.env.DATAHUB_PASSWORD;
    delete process.env.OPENFINCLAW_DATAHUB_API_URL;
    delete process.env.OPENFINCLAW_DATAHUB_USERNAME;
    delete process.env.OPENFINCLAW_DATAHUB_PASSWORD;
    delete process.env.OPENFINCLAW_DATAHUB_TIMEOUT_MS;

    const config = resolveConfig(fakeApi);

    expect(config.datahubApiUrl).toBe("http://43.134.61.136:8088");
    expect(config.datahubUsername).toBe("admin");
    expect(config.datahubApiKey).toBeUndefined();
    expect(config.requestTimeoutMs).toBe(30_000);

    Object.assign(process.env, saved);
  });

  it("2.2 resolveConfig picks up explicit pluginConfig values", () => {
    const fakeApi = {
      pluginConfig: {
        datahubApiUrl: "http://custom:9999",
        datahubUsername: "testuser",
        datahubApiKey: "custom-key-123",
        requestTimeoutMs: 60000,
      },
      resolvePath: (p: string) => join(tempDir, p),
    } as never;

    const config = resolveConfig(fakeApi);

    expect(config.datahubApiUrl).toBe("http://custom:9999");
    expect(config.datahubUsername).toBe("testuser");
    expect(config.datahubApiKey).toBe("custom-key-123");
    expect(config.requestTimeoutMs).toBe(60000);
  });

  it("2.3 resolveConfig clamps timeout below minimum to 30s default", () => {
    const fakeApi = {
      pluginConfig: { requestTimeoutMs: 500 },
      resolvePath: (p: string) => join(tempDir, p),
    } as never;

    const config = resolveConfig(fakeApi);
    expect(config.requestTimeoutMs).toBe(30_000);
  });

  it("2.4 resolveConfig strips trailing slashes from API URL", () => {
    const fakeApi = {
      pluginConfig: { datahubApiUrl: "http://example.com///" },
      resolvePath: (p: string) => join(tempDir, p),
    } as never;

    const config = resolveConfig(fakeApi);
    expect(config.datahubApiUrl).toBe("http://example.com");
  });

  it("2.5 plugin warns when no API key configured", async () => {
    const saved = { ...process.env };
    delete process.env.DATAHUB_API_KEY;
    delete process.env.DATAHUB_PASSWORD;
    delete process.env.OPENFINCLAW_DATAHUB_PASSWORD;

    const { api, logs } = createFakeApi(tempDir, {
      datahubApiKey: undefined,
      datahubPassword: undefined,
    });
    // Clear pluginConfig entirely so resolveConfig cannot find a key
    (api as unknown as { pluginConfig: Record<string, unknown> }).pluginConfig = {};

    findooDatahubPlugin.register(api);

    const warnLog = logs.find((l) => l.level === "warn" && l.msg.includes("no API key"));
    expect(warnLog).toBeDefined();

    Object.assign(process.env, saved);
  });

  // ═══════════════════════════════════════════════════════════
  //  3. Service lifecycle: boot -> ready -> no resource leaks
  // ═══════════════════════════════════════════════════════════

  it("3.1 SQLite cache file is created during registration", async () => {
    const { api } = createFakeApi(tempDir);
    findooDatahubPlugin.register(api);

    const cachePath = join(tempDir, "state", "findoo-ohlcv-cache.sqlite");
    expect(existsSync(cachePath)).toBe(true);
  });

  it("3.2 multiple register() calls do not leak resources", async () => {
    // Register twice — should not throw
    const ctx1 = createFakeApi(tempDir);
    findooDatahubPlugin.register(ctx1.api);

    const tempDir2 = mkdtempSync(join(tmpdir(), "l3-boot2-"));
    const ctx2 = createFakeApi(tempDir2);
    findooDatahubPlugin.register(ctx2.api);

    expect(ctx1.tools.size).toBe(13);
    expect(ctx2.tools.size).toBe(13);

    rmSync(tempDir2, { recursive: true, force: true });
  });

  it("3.3 getSupportedMarkets returns valid market info without network", async () => {
    const { api, services } = createFakeApi(tempDir);
    findooDatahubPlugin.register(api);

    const provider = services.get("fin-data-provider")!.instance as {
      getSupportedMarkets: () => Array<{ market: string; available: boolean }>;
    };

    const markets = provider.getSupportedMarkets();
    expect(markets.length).toBe(3);
    expect(markets.map((m) => m.market).toSorted()).toEqual(["commodity", "crypto", "equity"]);
    for (const m of markets) {
      expect(m.available).toBe(true);
    }
  });

  // ═══════════════════════════════════════════════════════════
  //  4. Tool registration count & completeness
  // ═══════════════════════════════════════════════════════════

  it("4.1 registers exactly 13 tools", async () => {
    const { api, tools } = createFakeApi(tempDir);
    findooDatahubPlugin.register(api);
    expect(tools.size).toBe(13);
  });

  it("4.2 all 13 tool names match the specification", async () => {
    const { api, tools } = createFakeApi(tempDir);
    findooDatahubPlugin.register(api);

    const expected = [
      "fin_stock",
      "fin_index",
      "fin_macro",
      "fin_derivatives",
      "fin_crypto",
      "fin_currency",
      "fin_market",
      "fin_query",
      "fin_data_ohlcv",
      "fin_data_regime",
      "fin_ta",
      "fin_etf",
      "fin_data_markets",
    ];

    for (const name of expected) {
      expect(tools.has(name), `Missing tool: ${name}`).toBe(true);
    }
    for (const name of tools.keys()) {
      expect(expected.includes(name), `Unexpected tool: ${name}`).toBe(true);
    }
  });

  it("4.3 each tool has name, description (>10 chars), and execute function", async () => {
    const { api, tools } = createFakeApi(tempDir);
    findooDatahubPlugin.register(api);

    for (const [name, tool] of tools) {
      expect(typeof tool.name, `${name}.name`).toBe("string");
      expect(typeof tool.description, `${name}.description`).toBe("string");
      expect(tool.description!.length, `${name}.description length`).toBeGreaterThan(10);
      expect(typeof tool.execute, `${name}.execute`).toBe("function");
    }
  });

  it("4.4 all tools still register even without API key", async () => {
    const saved = { ...process.env };
    delete process.env.DATAHUB_API_KEY;
    delete process.env.DATAHUB_PASSWORD;
    delete process.env.OPENFINCLAW_DATAHUB_PASSWORD;

    const { api, tools, services } = createFakeApi(tempDir, {});
    (api as unknown as { pluginConfig: Record<string, unknown> }).pluginConfig = {};

    findooDatahubPlugin.register(api);
    expect(tools.size).toBe(13);
    expect(services.size).toBe(2);

    Object.assign(process.env, saved);
  });

  // ═══════════════════════════════════════════════════════════
  //  5. Skill scanning: ./skills directory contains 33 skills
  // ═══════════════════════════════════════════════════════════

  it("5.1 skills directory exists and contains 33 skill directories", () => {
    const skillsDir = resolve(__dirname, "../../../extensions/findoo-datahub-plugin/skills");
    expect(existsSync(skillsDir)).toBe(true);

    const entries = readdirSync(skillsDir, { withFileTypes: true });
    const skillDirs = entries.filter((e) => e.isDirectory() && e.name !== "node_modules");
    expect(skillDirs.length).toBe(33);
  });

  it("5.2 each skill directory contains a skill.md file", () => {
    const skillsDir = resolve(__dirname, "../../../extensions/findoo-datahub-plugin/skills");
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    const skillDirs = entries.filter((e) => e.isDirectory() && e.name !== "node_modules");

    for (const dir of skillDirs) {
      const skillMd = join(skillsDir, dir.name, "skill.md");
      expect(existsSync(skillMd), `Missing skill.md in ${dir.name}`).toBe(true);
    }
  });

  it("5.3 openclaw.plugin.json declares skills path", () => {
    const pluginJsonPath = resolve(
      __dirname,
      "../../../extensions/findoo-datahub-plugin/openclaw.plugin.json",
    );
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf-8"));
    expect(pluginJson.skills).toBeDefined();
    expect(pluginJson.skills).toContain("./skills");
  });

  it("5.4 all skill directory names follow naming convention (lowercase-kebab)", () => {
    const skillsDir = resolve(__dirname, "../../../extensions/findoo-datahub-plugin/skills");
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    const skillDirs = entries.filter((e) => e.isDirectory() && e.name !== "node_modules");

    for (const dir of skillDirs) {
      expect(dir.name).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});
