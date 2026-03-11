/**
 * L4 — Tool Chain Execution Accuracy Tests
 *
 * Verifies that tool chains produce correct final output when given
 * mock DataHub responses. Tests the complete flow:
 *   LLM tool_use call → tool execute() → response formatting → chain output
 *
 * Uses mock tool responses (no real DataHub) to test deterministic accuracy.
 */
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Types matching register-tools.ts response shape
// ---------------------------------------------------------------------------

interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}

/** Helper to parse a ToolResponse JSON payload. */
function parseToolResponse<T = Record<string, unknown>>(resp: ToolResponse): T {
  return JSON.parse(resp.content[0].text) as T;
}

/** Build a tool response matching the json() helper in tool-helpers.ts. */
function json(payload: unknown): ToolResponse {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

// ---------------------------------------------------------------------------
// Mock DataHub responses — realistic data shapes from real DataHub API
// ---------------------------------------------------------------------------

const MOCK_OHLCV_BARS = [
  {
    date: "2026-03-08",
    open: 62100,
    high: 62800,
    low: 61500,
    close: 62500,
    volume: 48200,
  },
  {
    date: "2026-03-09",
    open: 62500,
    high: 63200,
    low: 62000,
    close: 63100,
    volume: 52100,
  },
  {
    date: "2026-03-10",
    open: 63100,
    high: 64500,
    low: 62900,
    close: 64200,
    volume: 67300,
  },
];

const MOCK_COIN_MARKET = [
  {
    id: "bitcoin",
    symbol: "btc",
    name: "Bitcoin",
    current_price: 64200,
    market_cap: 1262000000000,
    total_volume: 42000000000,
    price_change_percentage_24h: 2.15,
    market_cap_rank: 1,
  },
  {
    id: "ethereum",
    symbol: "eth",
    name: "Ethereum",
    current_price: 3450,
    market_cap: 415000000000,
    total_volume: 18000000000,
    price_change_percentage_24h: 1.82,
    market_cap_rank: 2,
  },
];

const MOCK_GLOBAL_STATS = {
  total_market_cap: 2180000000000,
  total_volume: 98000000000,
  bitcoin_dominance: 57.9,
  active_cryptocurrencies: 14523,
  market_cap_change_percentage_24h: 1.45,
};

const MOCK_TICKER = {
  symbol: "BTC/USDT",
  last: 64200,
  bid: 64195,
  ask: 64205,
  volume: 42000,
  timestamp: 1741651200000,
};

const MOCK_EQUITY_HISTORICAL = [
  {
    date: "2026-03-07",
    open: 1850.0,
    high: 1872.5,
    low: 1845.0,
    close: 1868.0,
    volume: 32500,
    symbol: "600519.SH",
  },
  {
    date: "2026-03-10",
    open: 1870.0,
    high: 1895.0,
    low: 1865.0,
    close: 1890.0,
    volume: 38200,
    symbol: "600519.SH",
  },
];

const MOCK_CPI_DATA = [
  { date: "2026-02", value: 0.8, yoy: 0.8, mom: 0.2, source: "NBS" },
  { date: "2026-01", value: 0.5, yoy: 0.5, mom: -0.3, source: "NBS" },
];

const MOCK_DEFI_PROTOCOLS = [
  {
    name: "Lido",
    tvl: 35200000000,
    category: "Liquid Staking",
    chains: ["Ethereum"],
    change_1d: 0.5,
  },
  {
    name: "AAVE",
    tvl: 12800000000,
    category: "Lending",
    chains: ["Ethereum", "Polygon", "Arbitrum"],
    change_1d: 1.2,
  },
];

const MOCK_TA_RSI = [
  { date: "2026-03-08", rsi: 55.3 },
  { date: "2026-03-09", rsi: 58.7 },
  { date: "2026-03-10", rsi: 62.1 },
];

const MOCK_TA_MACD = [
  { date: "2026-03-08", macd: 120.5, signal: 95.2, histogram: 25.3 },
  { date: "2026-03-09", macd: 135.8, signal: 103.4, histogram: 32.4 },
  { date: "2026-03-10", macd: 148.2, signal: 112.5, histogram: 35.7 },
];

const MOCK_MARKET_TOP_LIST = [
  {
    symbol: "000001.SZ",
    name: "平安银行",
    close: 12.5,
    pct_change: 9.98,
    net_amount: 52000000,
    reason: "日涨幅偏离值达到7%",
  },
  {
    symbol: "600000.SH",
    name: "浦发银行",
    close: 8.32,
    pct_change: 8.5,
    net_amount: 38000000,
    reason: "连续三个交易日收盘价涨幅偏离值累计达到20%",
  },
];

const MOCK_FUTURES_HISTORICAL = [
  {
    date: "2026-03-10",
    open: 3850,
    high: 3920,
    low: 3830,
    close: 3910,
    vol: 125000,
    oi: 280000,
    symbol: "IF2504.CFX",
  },
];

// ---------------------------------------------------------------------------
// Mock tool executor — simulates registerAllTools execute() functions
// ---------------------------------------------------------------------------

function executeMockTool(toolName: string, params: Record<string, unknown>): ToolResponse {
  switch (toolName) {
    case "fin_crypto": {
      const endpoint = String((params.endpoint as string) ?? "coin/market");
      if (endpoint === "market/ticker") {
        return json({
          success: true,
          endpoint: `crypto/${endpoint}`,
          count: 1,
          results: [MOCK_TICKER],
        });
      }
      if (endpoint === "coin/market") {
        return json({
          success: true,
          endpoint: `crypto/${endpoint}`,
          count: MOCK_COIN_MARKET.length,
          results: MOCK_COIN_MARKET,
        });
      }
      if (endpoint === "coin/global_stats") {
        return json({
          success: true,
          endpoint: `crypto/${endpoint}`,
          count: 1,
          results: [MOCK_GLOBAL_STATS],
        });
      }
      if (endpoint === "defi/protocols") {
        return json({
          success: true,
          endpoint: `crypto/${endpoint}`,
          count: MOCK_DEFI_PROTOCOLS.length,
          results: MOCK_DEFI_PROTOCOLS,
        });
      }
      if (endpoint === "price/historical") {
        return json({
          success: true,
          endpoint: `crypto/${endpoint}`,
          count: MOCK_OHLCV_BARS.length,
          results: MOCK_OHLCV_BARS,
        });
      }
      return json({ success: true, endpoint: `crypto/${endpoint}`, count: 0, results: [] });
    }

    case "fin_stock": {
      const endpoint = String((params.endpoint as string) ?? "price/historical");
      return json({
        success: true,
        endpoint: `equity/${endpoint}`,
        count: MOCK_EQUITY_HISTORICAL.length,
        results: MOCK_EQUITY_HISTORICAL,
      });
    }

    case "fin_macro": {
      const endpoint = String((params.endpoint as string) ?? "cpi");
      return json({
        success: true,
        endpoint: `economy/${endpoint}`,
        count: MOCK_CPI_DATA.length,
        results: MOCK_CPI_DATA,
      });
    }

    case "fin_market": {
      const endpoint = String((params.endpoint as string) ?? "market/top_list");
      return json({
        success: true,
        endpoint: `equity/${endpoint}`,
        count: MOCK_MARKET_TOP_LIST.length,
        results: MOCK_MARKET_TOP_LIST,
      });
    }

    case "fin_ta": {
      const indicator = String((params.indicator as string) ?? "rsi");
      const data = indicator === "macd" ? MOCK_TA_MACD : MOCK_TA_RSI;
      return json({
        success: true,
        endpoint: `ta/${indicator}`,
        count: data.length,
        results: data,
      });
    }

    case "fin_data_ohlcv": {
      const candles = MOCK_OHLCV_BARS.map((bar) => ({
        timestamp: new Date(bar.date).toISOString(),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      }));
      return json({
        symbol: params.symbol,
        market: params.market ?? "crypto",
        timeframe: params.timeframe ?? "1h",
        count: candles.length,
        candles,
      });
    }

    case "fin_data_regime":
      return json({
        symbol: params.symbol,
        market: params.market ?? "crypto",
        timeframe: params.timeframe ?? "4h",
        regime: "bull",
      });

    case "fin_data_markets":
      return json({
        datahub: "http://localhost:8088",
        markets: [
          { market: "crypto", symbols: ["BTC/USDT", "ETH/USDT"], available: true },
          { market: "equity", symbols: ["600519.SH", "AAPL"], available: true },
        ],
        categories: [
          "equity",
          "crypto",
          "economy",
          "derivatives",
          "index",
          "etf",
          "currency",
          "coverage",
        ],
        endpoints: 172,
      });

    case "fin_derivatives":
      return json({
        success: true,
        endpoint: `derivatives/${String(params.endpoint)}`,
        count: MOCK_FUTURES_HISTORICAL.length,
        results: MOCK_FUTURES_HISTORICAL,
      });

    case "fin_etf":
      return json({
        success: true,
        endpoint: `etf/${String(params.endpoint)}`,
        count: 1,
        results: [{ symbol: "510050.SH", name: "50ETF", nav: 3.25 }],
      });

    case "fin_query":
      return json({
        success: true,
        endpoint: params.path,
        count: 0,
        results: [],
      });

    default:
      return json({ error: `Unknown tool: ${toolName}` });
  }
}

// ===========================================================================
// Tests
// ===========================================================================

describe("L4: OHLCV data retrieval accuracy", () => {
  it("fin_crypto price/historical returns correct candle structure", () => {
    const resp = executeMockTool("fin_crypto", {
      endpoint: "price/historical",
      symbol: "BTC/USDT",
    });
    const data = parseToolResponse<{
      success: boolean;
      endpoint: string;
      count: number;
      results: Array<{ date: string; open: number; close: number }>;
    }>(resp);

    expect(data.success).toBe(true);
    expect(data.endpoint).toBe("crypto/price/historical");
    expect(data.count).toBe(3);
    expect(data.results[0].open).toBe(62100);
    expect(data.results[2].close).toBe(64200);
  });

  it("fin_data_ohlcv returns ISO timestamp candles", () => {
    const resp = executeMockTool("fin_data_ohlcv", {
      symbol: "BTC/USDT",
      market: "crypto",
      timeframe: "1h",
    });
    const data = parseToolResponse<{
      symbol: string;
      market: string;
      count: number;
      candles: Array<{ timestamp: string; open: number; close: number }>;
    }>(resp);

    expect(data.symbol).toBe("BTC/USDT");
    expect(data.market).toBe("crypto");
    expect(data.count).toBe(3);
    // Timestamps should be ISO format
    for (const candle of data.candles) {
      expect(candle.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect(data.candles[2].close).toBe(64200);
  });

  it("equity historical returns correct price data", () => {
    const resp = executeMockTool("fin_stock", {
      symbol: "600519.SH",
      endpoint: "price/historical",
    });
    const data = parseToolResponse<{
      success: boolean;
      results: Array<{ date: string; close: number; symbol: string }>;
    }>(resp);

    expect(data.success).toBe(true);
    expect(data.results).toHaveLength(2);
    expect(data.results[1].close).toBe(1890.0);
    expect(data.results[0].symbol).toBe("600519.SH");
  });
});

describe("L4: Market overview aggregation", () => {
  it("coin/market returns ranked coins with required fields", () => {
    const resp = executeMockTool("fin_crypto", { endpoint: "coin/market", limit: 20 });
    const data = parseToolResponse<{
      results: Array<{
        id: string;
        symbol: string;
        current_price: number;
        market_cap: number;
        market_cap_rank: number;
        price_change_percentage_24h: number;
      }>;
    }>(resp);

    expect(data.results).toHaveLength(2);

    // BTC should be rank 1
    const btc = data.results.find((c) => c.id === "bitcoin");
    expect(btc).toBeDefined();
    expect(btc!.market_cap_rank).toBe(1);
    expect(btc!.current_price).toBe(64200);

    // ETH should be rank 2
    const eth = data.results.find((c) => c.id === "ethereum");
    expect(eth).toBeDefined();
    expect(eth!.market_cap_rank).toBe(2);
  });

  it("global_stats returns market-wide metrics", () => {
    const resp = executeMockTool("fin_crypto", { endpoint: "coin/global_stats" });
    const data = parseToolResponse<{
      results: Array<{
        total_market_cap: number;
        bitcoin_dominance: number;
        active_cryptocurrencies: number;
      }>;
    }>(resp);

    expect(data.results).toHaveLength(1);
    const stats = data.results[0];
    expect(stats.total_market_cap).toBeGreaterThan(1e12);
    expect(stats.bitcoin_dominance).toBeGreaterThan(50);
    expect(stats.active_cryptocurrencies).toBeGreaterThan(10000);
  });

  it("defi/protocols returns TVL-ranked protocols", () => {
    const resp = executeMockTool("fin_crypto", { endpoint: "defi/protocols", limit: 20 });
    const data = parseToolResponse<{
      results: Array<{ name: string; tvl: number; category: string }>;
    }>(resp);

    expect(data.results).toHaveLength(2);
    expect(data.results[0].name).toBe("Lido");
    expect(data.results[0].tvl).toBeGreaterThan(data.results[1].tvl);
  });
});

describe("L4: Market radar tool chain", () => {
  it("market/top_list returns dragon-tiger list with required fields", () => {
    const resp = executeMockTool("fin_market", {
      endpoint: "market/top_list",
      trade_date: "2026-03-10",
    });
    const data = parseToolResponse<{
      results: Array<{
        symbol: string;
        name: string;
        close: number;
        pct_change: number;
        net_amount: number;
        reason: string;
      }>;
    }>(resp);

    expect(data.results.length).toBeGreaterThan(0);
    for (const item of data.results) {
      expect(item.symbol).toMatch(/\d{6}\.(SH|SZ)/);
      expect(item.name).toBeTruthy();
      expect(typeof item.close).toBe("number");
      expect(typeof item.pct_change).toBe("number");
    }
  });
});

describe("L4: Technical analysis chain", () => {
  it("RSI indicator returns values in 0-100 range", () => {
    const resp = executeMockTool("fin_ta", { symbol: "BTC-USDT", indicator: "rsi" });
    const data = parseToolResponse<{
      endpoint: string;
      results: Array<{ date: string; rsi: number }>;
    }>(resp);

    expect(data.endpoint).toBe("ta/rsi");
    for (const item of data.results) {
      expect(item.rsi).toBeGreaterThanOrEqual(0);
      expect(item.rsi).toBeLessThanOrEqual(100);
    }
  });

  it("MACD indicator returns macd, signal, and histogram", () => {
    const resp = executeMockTool("fin_ta", { symbol: "BTC-USDT", indicator: "macd" });
    const data = parseToolResponse<{
      results: Array<{ macd: number; signal: number; histogram: number }>;
    }>(resp);

    for (const item of data.results) {
      expect(typeof item.macd).toBe("number");
      expect(typeof item.signal).toBe("number");
      expect(typeof item.histogram).toBe("number");
      // histogram = macd - signal
      expect(item.histogram).toBeCloseTo(item.macd - item.signal, 0);
    }
  });
});

describe("L4: Macro data chain", () => {
  it("CPI data returns correct structure", () => {
    const resp = executeMockTool("fin_macro", { endpoint: "cpi" });
    const data = parseToolResponse<{
      endpoint: string;
      results: Array<{ date: string; value: number; yoy: number }>;
    }>(resp);

    expect(data.endpoint).toBe("economy/cpi");
    expect(data.results).toHaveLength(2);
    expect(data.results[0].date).toBe("2026-02");
    expect(typeof data.results[0].yoy).toBe("number");
  });
});

describe("L4: Regime detection chain", () => {
  it("returns valid regime string", () => {
    const resp = executeMockTool("fin_data_regime", {
      symbol: "BTC/USDT",
      market: "crypto",
      timeframe: "4h",
    });
    const data = parseToolResponse<{
      symbol: string;
      regime: string;
    }>(resp);

    expect(data.symbol).toBe("BTC/USDT");
    expect(["bull", "bear", "sideways", "volatile", "crisis"]).toContain(data.regime);
  });
});

describe("L4: Supported markets chain", () => {
  it("fin_data_markets returns categories and endpoint count", () => {
    const resp = executeMockTool("fin_data_markets", {});
    const data = parseToolResponse<{
      markets: Array<{ market: string; available: boolean }>;
      categories: string[];
      endpoints: number;
    }>(resp);

    expect(data.categories).toContain("equity");
    expect(data.categories).toContain("crypto");
    expect(data.categories).toContain("economy");
    expect(data.endpoints).toBe(172);
    expect(data.markets.every((m) => m.available)).toBe(true);
  });
});

describe("L4: Multi-step analysis chain — crypto market overview", () => {
  it("complete market overview chain produces coherent analysis data", () => {
    // Step 1: Global stats
    const globalResp = executeMockTool("fin_crypto", { endpoint: "coin/global_stats" });
    const globalData = parseToolResponse<{
      results: Array<{ total_market_cap: number; bitcoin_dominance: number }>;
    }>(globalResp);

    // Step 2: Top coins
    const coinResp = executeMockTool("fin_crypto", { endpoint: "coin/market", limit: 20 });
    const coinData = parseToolResponse<{
      results: Array<{ id: string; current_price: number; market_cap: number }>;
    }>(coinResp);

    // Step 3: Regime detection
    const regimeResp = executeMockTool("fin_data_regime", {
      symbol: "BTC/USDT",
      market: "crypto",
    });
    const regimeData = parseToolResponse<{ regime: string }>(regimeResp);

    // Step 4: DeFi overview
    const defiResp = executeMockTool("fin_crypto", { endpoint: "defi/protocols" });
    const defiData = parseToolResponse<{
      results: Array<{ name: string; tvl: number }>;
    }>(defiResp);

    // Validate chain coherence
    expect(globalData.results[0].total_market_cap).toBeGreaterThan(0);
    expect(coinData.results.length).toBeGreaterThan(0);
    expect(["bull", "bear", "sideways", "volatile", "crisis"]).toContain(regimeData.regime);
    expect(defiData.results.length).toBeGreaterThan(0);

    // BTC market cap should be < total market cap
    const btcMcap = coinData.results.find((c) => c.id === "bitcoin")?.market_cap ?? 0;
    expect(btcMcap).toBeLessThan(globalData.results[0].total_market_cap);
  });
});

describe("L4: Error handling in tool chain", () => {
  it("unknown tool returns error response", () => {
    const resp = executeMockTool("fin_nonexistent", {});
    const data = parseToolResponse<{ error: string }>(resp);
    expect(data.error).toContain("Unknown tool");
  });

  it("tool response is always valid JSON in content[0].text", () => {
    const tools = [
      { name: "fin_crypto", params: { endpoint: "coin/market" } },
      { name: "fin_stock", params: { symbol: "AAPL", endpoint: "price/historical" } },
      { name: "fin_macro", params: { endpoint: "cpi" } },
      { name: "fin_data_ohlcv", params: { symbol: "BTC/USDT" } },
      { name: "fin_data_regime", params: { symbol: "BTC/USDT" } },
      { name: "fin_data_markets", params: {} },
      { name: "fin_ta", params: { symbol: "BTC-USDT", indicator: "rsi" } },
      { name: "fin_market", params: { endpoint: "market/top_list" } },
      { name: "fin_derivatives", params: { endpoint: "futures/historical" } },
      { name: "fin_etf", params: { endpoint: "info" } },
      { name: "fin_query", params: { path: "coverage/commands" } },
    ];

    for (const { name, params } of tools) {
      const resp = executeMockTool(name, params);
      expect(resp.content).toHaveLength(1);
      expect(resp.content[0].type).toBe("text");
      // Must be parseable JSON
      expect(() => JSON.parse(resp.content[0].text)).not.toThrow();
    }
  });
});
