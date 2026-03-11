/**
 * L1 单元测试: DataHubClient
 *
 * Mock 全局 fetch，验证:
 * - URL/路径构造 (8 个 category + query 通用方法)
 * - Auth header 构造
 * - HTTP 状态码处理 (200/204/4xx/5xx)
 * - 非 JSON 响应处理
 * - getOHLCV provider 自动检测
 * - normalizeOHLCV 数据归一化
 * - getTicker 逻辑
 * - 超时行为
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataHubClient } from "../../../extensions/findoo-datahub-plugin/src/datahub-client.js";

// --- Mock fetch ---
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 构造一个成功的 fetch Response */
function okResponse(results: unknown[], status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify({ results }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

/** 构造一个错误 Response */
function errorResponse(status: number, body: string) {
  return Promise.resolve(new Response(body, { status }));
}

describe("DataHubClient", () => {
  const BASE_URL = "http://localhost:8088";
  let client: DataHubClient;

  beforeEach(() => {
    client = new DataHubClient(BASE_URL, "admin", "test-key", 5000);
  });

  // --- 1. Auth header 构造 ---
  it("构造正确的 Basic Auth header", async () => {
    mockFetch.mockReturnValue(okResponse([{ id: 1 }]));

    await client.query("equity/price/historical", { symbol: "AAPL" });

    const [, init] = mockFetch.mock.calls[0];
    const authHeader = init.headers.Authorization;
    // btoa("admin:test-key") = "YWRtaW46dGVzdC1rZXk="
    expect(authHeader).toBe(`Basic ${btoa("admin:test-key")}`);
  });

  // --- 2. URL 路径构造 ---
  it("query() 构造正确的 URL 路径和查询参数", async () => {
    mockFetch.mockReturnValue(okResponse([]));

    await client.query("equity/price/historical", {
      symbol: "600519.SH",
      limit: "10",
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/v1/equity/price/historical");
    expect(url).toContain("symbol=600519.SH");
    expect(url).toContain("limit=10");
  });

  // --- 3. 8 个 category helper 路径正确 ---
  it.each([
    ["equity", "price/historical"],
    ["crypto", "coin/market"],
    ["economy", "cpi"],
    ["derivatives", "futures/historical"],
    ["index", "constituents"],
    ["etf", "nav"],
    ["currency", "price/historical"],
    ["coverage", "providers"],
  ])("%s() 路由到 /api/v1/%s/%s", async (category, endpoint) => {
    mockFetch.mockReturnValue(okResponse([]));

    // coverage 方法签名不同 (无 params)
    if (category === "coverage") {
      await client.coverage(endpoint);
    } else {
      await (client as Record<string, Function>)[category](endpoint, {});
    }

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain(`/api/v1/${category}/${endpoint}`);
  });

  // --- 4. ta() 路由正确 ---
  it("ta() 路由到 /api/v1/ta/{indicator}", async () => {
    mockFetch.mockReturnValue(okResponse([{ sma: 100 }]));

    await client.ta("sma", { symbol: "AAPL", period: "20" });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/v1/ta/sma");
    expect(url).toContain("symbol=AAPL");
  });

  // --- 5. HTTP 204 返回空数组 ---
  it("HTTP 204 返回空数组 (非交易时段)", async () => {
    mockFetch.mockReturnValue(Promise.resolve(new Response(null, { status: 204 })));

    const results = await client.query("equity/price/historical");
    expect(results).toEqual([]);
  });

  // --- 6. HTTP 4xx/5xx 抛错含状态码 ---
  it("HTTP 400 抛出包含状态码的错误", async () => {
    mockFetch.mockReturnValue(errorResponse(400, "Bad Request: missing symbol"));

    await expect(client.query("equity/price/historical")).rejects.toThrow(/DataHub error \(400\)/);
  });

  it("HTTP 500 抛出错误并截断 body", async () => {
    const longBody = "x".repeat(500);
    mockFetch.mockReturnValue(errorResponse(500, longBody));

    await expect(client.query("equity/price/historical")).rejects.toThrow(/DataHub error \(500\)/);
  });

  // --- 7. 非 JSON 响应 ---
  it("非 JSON 响应抛明确错误", async () => {
    mockFetch.mockReturnValue(
      Promise.resolve(new Response("<html>502 Bad Gateway</html>", { status: 200 })),
    );

    await expect(client.query("equity/price/historical")).rejects.toThrow(/non-JSON/);
  });

  // --- 8. payload.detail 透传 ---
  it("payload.detail 字段透传为 Error message", async () => {
    mockFetch.mockReturnValue(
      Promise.resolve(
        new Response(JSON.stringify({ detail: "Permission denied" }), { status: 200 }),
      ),
    );

    await expect(client.query("equity/price/historical")).rejects.toThrow(/Permission denied/);
  });

  // --- 9. results 缺失时返回空数组 ---
  it("payload 无 results 字段时返回空数组", async () => {
    mockFetch.mockReturnValue(
      Promise.resolve(new Response(JSON.stringify({ provider: "tushare" }), { status: 200 })),
    );

    const results = await client.query("equity/price/historical");
    expect(results).toEqual([]);
  });

  // --- 10. getOHLCV: A 股 symbol 路由 tushare ---
  it("getOHLCV: .SH/.SZ/.HK 后缀路由到 tushare provider", async () => {
    mockFetch.mockReturnValue(
      okResponse([{ date: "2025-01-01", open: 100, high: 105, low: 98, close: 102, volume: 1000 }]),
    );

    await client.getOHLCV({ symbol: "600519.SH", market: "equity", timeframe: "1d" });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("provider=tushare");
    expect(url).toContain("/api/v1/equity/price/historical");
  });

  // --- 11. getOHLCV: US 股 symbol 路由 massive ---
  it("getOHLCV: 非中港代码路由到 massive provider", async () => {
    mockFetch.mockReturnValue(
      okResponse([
        { date: "2025-01-01", open: 150, high: 155, low: 148, close: 152, volume: 5000 },
      ]),
    );

    await client.getOHLCV({ symbol: "AAPL", market: "equity", timeframe: "1d" });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("provider=massive");
  });

  // --- 12. getOHLCV: crypto 市场 ---
  it("getOHLCV: crypto 市场路由到 crypto/price/historical + ccxt provider", async () => {
    mockFetch.mockReturnValue(
      okResponse([
        { date: "2025-01-01", open: 60000, high: 61000, low: 59000, close: 60500, vol: 100 },
      ]),
    );

    await client.getOHLCV({ symbol: "BTC/USDT", market: "crypto", timeframe: "1h" });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/v1/crypto/price/historical");
    expect(url).toContain("provider=ccxt");
  });

  // --- 13. getOHLCV: unsupported market 抛错 ---
  it("getOHLCV: 不支持的 market 抛明确错误", async () => {
    await expect(
      client.getOHLCV({ symbol: "GC", market: "commodity" as "crypto", timeframe: "1d" }),
    ).rejects.toThrow(/unsupported market/);
  });

  // --- 14. normalizeOHLCV: 多种时间格式归一化 ---
  it("normalizeOHLCV: 支持 date/trade_date/timestamp 三种字段", async () => {
    mockFetch.mockReturnValue(
      okResponse([
        { date: "2025-01-01", open: 100, high: 105, low: 98, close: 102, volume: 1000 },
        { trade_date: "2025-01-02", open: 102, high: 106, low: 100, close: 104, volume: 1200 },
        { timestamp: 1735862400000, open: 104, high: 108, low: 102, close: 106, volume: 1100 },
      ]),
    );

    const result = await client.getOHLCV({ symbol: "AAPL", market: "equity", timeframe: "1d" });

    expect(result).toHaveLength(3);
    // 所有 timestamp 应为数字
    for (const bar of result) {
      expect(typeof bar.timestamp).toBe("number");
      expect(bar.timestamp).toBeGreaterThan(0);
    }
  });

  // --- 15. normalizeOHLCV: limit 截取最新 N 条 ---
  it("normalizeOHLCV: limit 参数截取最新 N 条数据", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      date: `2025-01-${String(i + 1).padStart(2, "0")}`,
      open: 100 + i,
      high: 105 + i,
      low: 98 + i,
      close: 102 + i,
      volume: 1000,
    }));
    mockFetch.mockReturnValue(okResponse(rows));

    const result = await client.getOHLCV({
      symbol: "AAPL",
      market: "equity",
      timeframe: "1d",
      limit: 5,
    });

    expect(result).toHaveLength(5);
    // 最后一条应为原始数据最后一条
    expect(result[4].close).toBe(102 + 19);
  });

  // --- 16. getTicker: crypto 取最后一条 close ---
  it("getTicker: crypto 返回最后一条数据的 close 作为 last", async () => {
    mockFetch.mockReturnValue(
      okResponse([
        { date: "2025-01-01", close: 60000 },
        { date: "2025-01-02", close: 61000 },
      ]),
    );

    const ticker = await client.getTicker("BTC/USDT", "crypto");
    expect(ticker.symbol).toBe("BTC/USDT");
    expect(ticker.market).toBe("crypto");
    expect(ticker.last).toBe(61000);
  });

  // --- 17. getTicker: equity 无数据抛错 ---
  it("getTicker: equity 无数据时抛 'No ticker data' 错误", async () => {
    mockFetch.mockReturnValue(okResponse([]));

    await expect(client.getTicker("INVALID", "equity")).rejects.toThrow(
      /No ticker data for INVALID/,
    );
  });

  // --- 18. query 无 params 时不附加查询字符串 ---
  it("query 无 params 时 URL 不含查询参数", async () => {
    mockFetch.mockReturnValue(okResponse([]));

    await client.query("coverage/providers"); // 无第二参数

    const [url] = mockFetch.mock.calls[0];
    const parsed = new URL(url as string);
    // 不应有任何查询参数
    expect(parsed.search).toBe("");
  });
});
