/**
 * L3 Gateway — HTTP Endpoints & Error Handling Tests
 *
 * Validates:
 *   1. Health check endpoint behavior (fin_data_markets as proxy)
 *   2. Error code mapping (auth failures, rate limits, server errors)
 *   3. Tool execute() error envelope consistency
 *   4. HTTP route registration (DataHub has no custom routes — verify none registered)
 *
 * Uses mock fetch to simulate DataHub server responses without network.
 *
 * Run:
 *   npx vitest run tests/findoo-datahub-plugin/l3-gateway/http-endpoints.test.ts
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import findooDatahubPlugin from "../../../extensions/findoo-datahub-plugin/index.js";

/* ---------- types ---------- */

type ToolDef = {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};

/* ---------- fake gateway API ---------- */

function createFakeApi(stateDir: string, pluginConfig: Record<string, unknown> = {}) {
  const tools = new Map<string, ToolDef>();
  const services = new Map<string, unknown>();
  const httpHandlers: Array<{ path: string; handler: unknown }> = [];
  const httpRoutes: Array<unknown> = [];

  const api = {
    id: "findoo-datahub-plugin",
    name: "Findoo DataHub",
    source: "gateway",
    config: {},
    pluginConfig: {
      datahubApiKey: "test-key",
      datahubApiUrl: "http://mock-datahub:8088",
      ...pluginConfig,
    },
    runtime: { version: "test-gateway-l3-http", services: new Map() },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    log() {},
    registerTool(tool: ToolDef) {
      tools.set(tool.name, tool);
    },
    registerHook: vi.fn(),
    registerHttpHandler(...args: unknown[]) {
      httpHandlers.push({ path: String(args[0]), handler: args[1] });
    },
    registerHttpRoute(...args: unknown[]) {
      httpRoutes.push(args);
    },
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService(svc: { id: string; instance: unknown }) {
      services.set(svc.id, svc.instance);
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

  return { api: api as never, tools, services, httpHandlers, httpRoutes };
}

function parseResult(result: unknown): Record<string, unknown> {
  const res = result as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text);
}

/* ---------- tests ---------- */

describe("L3 — HTTP Endpoints & Error Handling", () => {
  let tempDir: string;
  let tools: Map<string, ToolDef>;
  let _fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "l3-http-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ═══════════════════════════════════════════════════════════
  //  1. Health check — fin_data_markets as local health probe
  // ═══════════════════════════════════════════════════════════

  it("1.1 fin_data_markets returns status without network calls", async () => {
    const ctx = createFakeApi(tempDir);
    findooDatahubPlugin.register(ctx.api);
    tools = ctx.tools;

    const result = parseResult(await tools.get("fin_data_markets")!.execute("h1", {}));
    expect(result).toHaveProperty("datahub");
    expect(result).toHaveProperty("markets");
    expect(result).toHaveProperty("categories");
    expect(result.endpoints).toBe(172);
  });

  it("1.2 fin_data_markets categories include all 8 data domains", async () => {
    const ctx = createFakeApi(tempDir);
    findooDatahubPlugin.register(ctx.api);
    tools = ctx.tools;

    const result = parseResult(await tools.get("fin_data_markets")!.execute("h2", {}));
    const cats = result.categories as string[];
    const expected = [
      "equity",
      "crypto",
      "economy",
      "derivatives",
      "index",
      "etf",
      "currency",
      "coverage",
    ];
    for (const cat of expected) {
      expect(cats, `Missing category: ${cat}`).toContain(cat);
    }
  });

  // ═══════════════════════════════════════════════════════════
  //  2. No custom HTTP routes (DataHub plugin is tool-only)
  // ═══════════════════════════════════════════════════════════

  it("2.1 plugin registers zero custom HTTP handlers", async () => {
    const ctx = createFakeApi(tempDir);
    findooDatahubPlugin.register(ctx.api);

    expect(ctx.httpHandlers.length).toBe(0);
  });

  it("2.2 plugin registers zero custom HTTP routes", async () => {
    const ctx = createFakeApi(tempDir);
    findooDatahubPlugin.register(ctx.api);

    expect(ctx.httpRoutes.length).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════
  //  3. Error code mapping — 401 / 429 / 500
  // ═══════════════════════════════════════════════════════════

  it("3.1 DataHub 401 Unauthorized maps to error envelope", async () => {
    const ctx = createFakeApi(tempDir);
    findooDatahubPlugin.register(ctx.api);
    tools = ctx.tools;

    // Mock fetch to return 401
    _fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }),
      );

    const result = parseResult(
      await tools.get("fin_stock")!.execute("err-401", {
        symbol: "600519.SH",
        endpoint: "price/historical",
      }),
    );

    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe("string");
    expect(String(result.error)).toMatch(/401|[Uu]nauthorized|error/);
    expect(result.success).toBeUndefined();
  });

  it("3.2 DataHub 429 Rate Limit maps to error envelope", async () => {
    const ctx = createFakeApi(tempDir);
    findooDatahubPlugin.register(ctx.api);
    tools = ctx.tools;

    _fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("Rate limit exceeded", { status: 429, statusText: "Too Many Requests" }),
      );

    const result = parseResult(
      await tools.get("fin_crypto")!.execute("err-429", {
        endpoint: "coin/market",
      }),
    );

    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe("string");
    expect(String(result.error)).toMatch(/429|[Rr]ate|error/);
  });

  it("3.3 DataHub 500 Internal Error maps to error envelope", async () => {
    const ctx = createFakeApi(tempDir);
    findooDatahubPlugin.register(ctx.api);
    tools = ctx.tools;

    _fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" }),
      );

    const result = parseResult(
      await tools.get("fin_macro")!.execute("err-500", {
        endpoint: "cpi",
      }),
    );

    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe("string");
    expect(String(result.error)).toMatch(/500|[Ii]nternal|error/);
  });

  it("3.4 DataHub returns non-JSON response maps to error envelope", async () => {
    const ctx = createFakeApi(tempDir);
    findooDatahubPlugin.register(ctx.api);
    tools = ctx.tools;

    _fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("<html>Bad Gateway</html>", { status: 200, statusText: "OK" }),
      );

    const result = parseResult(
      await tools.get("fin_index")!.execute("err-nonjson", {
        endpoint: "available",
      }),
    );

    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe("string");
    expect(String(result.error)).toMatch(/JSON|parse|non-JSON/i);
  });

  // ═══════════════════════════════════════════════════════════
  //  4. Error envelope consistency across all tool types
  // ═══════════════════════════════════════════════════════════

  it("4.1 fin_query returns error envelope for missing path", async () => {
    const ctx = createFakeApi(tempDir);
    findooDatahubPlugin.register(ctx.api);
    tools = ctx.tools;

    const result = parseResult(await tools.get("fin_query")!.execute("err-nopath", { path: "" }));

    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe("string");
    expect(result.success).toBeUndefined();
  });

  it("4.2 network timeout produces error envelope (not unhandled rejection)", async () => {
    const ctx = createFakeApi(tempDir);
    findooDatahubPlugin.register(ctx.api);
    tools = ctx.tools;

    _fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new DOMException("The operation was aborted.", "AbortError"));

    const result = parseResult(
      await tools.get("fin_stock")!.execute("err-timeout", {
        symbol: "600519.SH",
        endpoint: "price/historical",
      }),
    );

    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe("string");
  });

  it("4.3 DataHub detail error field is surfaced in error envelope", async () => {
    const ctx = createFakeApi(tempDir);
    findooDatahubPlugin.register(ctx.api);
    tools = ctx.tools;

    _fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Symbol not found in database" }), {
        status: 200,
        statusText: "OK",
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = parseResult(
      await tools.get("fin_stock")!.execute("err-detail", {
        symbol: "INVALID_SYM",
        endpoint: "price/historical",
      }),
    );

    expect(result.error).toBeDefined();
    expect(String(result.error)).toContain("Symbol not found");
  });

  it("4.4 DataHub 204 No Content returns empty results (not error)", async () => {
    const ctx = createFakeApi(tempDir);
    findooDatahubPlugin.register(ctx.api);
    tools = ctx.tools;

    _fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 204, statusText: "No Content" }));

    const result = parseResult(
      await tools.get("fin_derivatives")!.execute("empty-204", {
        endpoint: "futures/historical",
        symbol: "IF2501.CFX",
      }),
    );

    expect(result.success).toBe(true);
    expect(result.count).toBe(0);
    expect(Array.isArray(result.results)).toBe(true);
    expect((result.results as unknown[]).length).toBe(0);
  });

  it("4.5 error in one tool does not affect other tools", async () => {
    const ctx = createFakeApi(tempDir);
    findooDatahubPlugin.register(ctx.api);
    tools = ctx.tools;

    // First call fails
    _fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [{ value: 42 }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const bad = parseResult(
      await tools.get("fin_stock")!.execute("err-iso-1", {
        symbol: "X",
        endpoint: "price/historical",
      }),
    );
    expect(bad.error).toBeDefined();

    // Second call succeeds
    const good = parseResult(
      await tools.get("fin_macro")!.execute("err-iso-2", {
        endpoint: "cpi",
      }),
    );
    expect(good.success).toBe(true);
    expect(good.count).toBe(1);
  });
});
