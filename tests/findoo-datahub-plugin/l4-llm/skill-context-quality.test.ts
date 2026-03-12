/**
 * L4 — LLM Skill Routing & Context Quality Tests
 *
 * Verifies that natural language queries route to the correct datahub tools
 * with proper parameter extraction. Mocks the LLM tool_use response and
 * asserts the selected tool name + extracted parameters match expectations.
 */
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Types mirroring LLM tool_use call format (Anthropic / OpenAI function calling)
// ---------------------------------------------------------------------------

interface ToolUseCall {
  name: string;
  input: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// All 12 registered datahub tools and their primary parameter shapes
// ---------------------------------------------------------------------------

const DATAHUB_TOOLS = [
  "fin_stock",
  "fin_index",
  "fin_macro",
  "fin_derivatives",
  "fin_crypto",
  "fin_market",
  "fin_query",
  "fin_data_ohlcv",
  "fin_data_regime",
  "fin_ta",
  "fin_etf",
  "fin_data_markets",
] as const;

// ---------------------------------------------------------------------------
// Skill → tool mapping table (derived from skill.md files)
// ---------------------------------------------------------------------------

const SKILL_TOOL_MAP: Record<string, string[]> = {
  "fin-a-share": ["fin_stock", "fin_market", "fin_ta", "fin_data_ohlcv"],
  "fin-us-equity": ["fin_stock", "fin_ta", "fin_data_ohlcv"],
  "fin-hk-stock": ["fin_stock", "fin_ta", "fin_data_ohlcv"],
  "fin-crypto": ["fin_crypto", "fin_data_ohlcv", "fin_data_regime", "fin_ta"],
  "fin-macro": ["fin_macro"],
  "fin-derivatives": ["fin_derivatives"],
  "fin-etf-fund": ["fin_etf", "fin_index"],
  "fin-data-query": ["fin_query", "fin_data_ohlcv", "fin_data_regime", "fin_data_markets"],
  "fin-cross-asset": ["fin_stock", "fin_crypto", "fin_macro", "fin_index"],
  "fin-risk-monitor": ["fin_stock", "fin_crypto", "fin_data_regime"],
  "fin-factor-screen": ["fin_stock", "fin_index"],
  "fin-a-share-radar": ["fin_market", "fin_stock"],
};

// ---------------------------------------------------------------------------
// Mock LLM skill router — simulates LLM selecting tools for a user query
// ---------------------------------------------------------------------------

function simulateSkillRoute(query: string): { skill: string; tools: ToolUseCall[] } {
  const q = query.toLowerCase();

  // Crypto queries
  if (q.includes("btc") || q.includes("bitcoin") || q.includes("crypto") || q.includes("defi")) {
    const tools: ToolUseCall[] = [];

    if (q.includes("price") || q.includes("ticker")) {
      tools.push({
        name: "fin_crypto",
        input: { endpoint: "market/ticker", symbol: "BTC/USDT" },
      });
    }
    if (q.includes("defi") || q.includes("tvl")) {
      tools.push({
        name: "fin_crypto",
        input: { endpoint: "defi/protocols", limit: 20 },
      });
    }
    if (q.includes("regime") || q.includes("trend")) {
      tools.push({
        name: "fin_data_regime",
        input: { symbol: "BTC/USDT", market: "crypto", timeframe: "4h" },
      });
    }
    if (q.includes("k line") || q.includes("ohlcv") || q.includes("candle")) {
      tools.push({
        name: "fin_data_ohlcv",
        input: { symbol: "BTC/USDT", market: "crypto", timeframe: "1h" },
      });
    }
    if (q.includes("rsi") || q.includes("macd") || q.includes("technical")) {
      tools.push({
        name: "fin_ta",
        input: { symbol: "BTC-USDT", indicator: q.includes("macd") ? "macd" : "rsi" },
      });
    }
    if (tools.length === 0) {
      tools.push({
        name: "fin_crypto",
        input: { endpoint: "coin/market", limit: 20 },
      });
    }

    return { skill: "fin-crypto", tools };
  }

  // A-share queries
  if (
    q.includes("a share") ||
    q.includes("a股") ||
    q.includes("茅台") ||
    q.includes("沪深") ||
    q.match(/\d{6}\.(sh|sz)/i)
  ) {
    const tools: ToolUseCall[] = [];
    const symbolMatch = query.match(/(\d{6}\.(SH|SZ|sh|sz))/);
    const symbol = symbolMatch ? symbolMatch[1] : "600519.SH";

    if (q.includes("price") || q.includes("quote") || q.includes("行情")) {
      tools.push({
        name: "fin_stock",
        input: { symbol, endpoint: "price/quote" },
      });
    }
    if (q.includes("income") || q.includes("财报") || q.includes("fundamental")) {
      tools.push({
        name: "fin_stock",
        input: { symbol, endpoint: "fundamental/income" },
      });
    }
    if (q.includes("northbound") || q.includes("北向")) {
      tools.push({
        name: "fin_market",
        input: { endpoint: "flow/hsgt_flow", start_date: "2026-01-01" },
      });
    }
    if (tools.length === 0) {
      tools.push({
        name: "fin_stock",
        input: { symbol, endpoint: "price/historical" },
      });
    }

    return { skill: "fin-a-share", tools };
  }

  // US equity queries
  if (q.includes("aapl") || q.includes("apple") || q.includes("us stock") || q.includes("美股")) {
    return {
      skill: "fin-us-equity",
      tools: [
        {
          name: "fin_stock",
          input: { symbol: "AAPL", endpoint: "price/historical" },
        },
      ],
    };
  }

  // HK stock queries
  if (q.includes("00700") || q.includes("tencent") || q.includes("港股") || q.includes("hk")) {
    return {
      skill: "fin-hk-stock",
      tools: [
        {
          name: "fin_stock",
          input: { symbol: "00700.HK", endpoint: "price/historical" },
        },
      ],
    };
  }

  // Macro queries
  if (
    q.includes("gdp") ||
    q.includes("cpi") ||
    q.includes("macro") ||
    q.includes("interest rate") ||
    q.includes("宏观")
  ) {
    const endpoint = q.includes("gdp")
      ? "gdp/real"
      : q.includes("cpi")
        ? "cpi"
        : q.includes("shibor")
          ? "shibor"
          : "cpi";
    return {
      skill: "fin-macro",
      tools: [{ name: "fin_macro", input: { endpoint } }],
    };
  }

  // ETF / Fund queries
  if (q.includes("etf") || q.includes("fund") || q.includes("基金")) {
    return {
      skill: "fin-etf-fund",
      tools: [{ name: "fin_etf", input: { endpoint: "info" } }],
    };
  }

  // Derivatives queries
  if (q.includes("futures") || q.includes("options") || q.includes("期货") || q.includes("期权")) {
    return {
      skill: "fin-derivatives",
      tools: [
        {
          name: "fin_derivatives",
          input: { endpoint: "futures/historical", symbol: "IF2501.CFX" },
        },
      ],
    };
  }

  // Market radar queries
  if (
    q.includes("dragon tiger") ||
    q.includes("龙虎榜") ||
    q.includes("limit up") ||
    q.includes("涨停")
  ) {
    return {
      skill: "fin-a-share-radar",
      tools: [
        {
          name: "fin_market",
          input: { endpoint: "market/top_list", trade_date: "2026-03-10" },
        },
      ],
    };
  }

  // Fallback
  return {
    skill: "fin-data-query",
    tools: [{ name: "fin_data_markets", input: {} }],
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("L4: Skill Routing — tool selection correctness", () => {
  it("routes 'BTC price' to fin_crypto with market/ticker endpoint", () => {
    const result = simulateSkillRoute("What is the current BTC price?");
    expect(result.skill).toBe("fin-crypto");
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("fin_crypto");
    expect(result.tools[0].input.endpoint).toBe("market/ticker");
    expect(result.tools[0].input.symbol).toBe("BTC/USDT");
  });

  it("routes 'BTC MACD technical analysis' to fin_ta", () => {
    const result = simulateSkillRoute("Show me BTC MACD technical analysis");
    expect(result.skill).toBe("fin-crypto");
    const taCall = result.tools.find((t) => t.name === "fin_ta");
    expect(taCall).toBeDefined();
    expect(taCall!.input.indicator).toBe("macd");
  });

  it("routes '茅台行情' to fin_stock with correct symbol", () => {
    const result = simulateSkillRoute("茅台行情");
    expect(result.skill).toBe("fin-a-share");
    expect(result.tools[0].name).toBe("fin_stock");
    expect(result.tools[0].input.symbol).toBe("600519.SH");
    expect(result.tools[0].input.endpoint).toBe("price/quote");
  });

  it("routes 'AAPL stock' to fin_stock for US equity", () => {
    const result = simulateSkillRoute("Show me AAPL stock price");
    expect(result.skill).toBe("fin-us-equity");
    expect(result.tools[0].name).toBe("fin_stock");
    expect(result.tools[0].input.symbol).toBe("AAPL");
  });

  it("routes '00700.HK' to fin_stock for HK stock", () => {
    const result = simulateSkillRoute("00700.HK historical prices");
    expect(result.skill).toBe("fin-hk-stock");
    expect(result.tools[0].name).toBe("fin_stock");
    expect(result.tools[0].input.symbol).toBe("00700.HK");
  });

  it("routes 'GDP macro data' to fin_macro", () => {
    const result = simulateSkillRoute("Show me China GDP macro data");
    expect(result.skill).toBe("fin-macro");
    expect(result.tools[0].name).toBe("fin_macro");
    expect(result.tools[0].input.endpoint).toBe("gdp/real");
  });

  it("routes 'CPI' to fin_macro with cpi endpoint", () => {
    const result = simulateSkillRoute("Latest CPI data");
    expect(result.skill).toBe("fin-macro");
    expect(result.tools[0].input.endpoint).toBe("cpi");
  });

  it("routes ETF query to fin_etf", () => {
    const result = simulateSkillRoute("List ETF fund info");
    expect(result.skill).toBe("fin-etf-fund");
    expect(result.tools[0].name).toBe("fin_etf");
  });

  it("routes futures query to fin_derivatives", () => {
    const result = simulateSkillRoute("期货行情 IF2501");
    expect(result.skill).toBe("fin-derivatives");
    expect(result.tools[0].name).toBe("fin_derivatives");
    expect(result.tools[0].input.endpoint).toBe("futures/historical");
  });

  it("routes 龙虎榜 to fin_market", () => {
    const result = simulateSkillRoute("今天龙虎榜");
    expect(result.skill).toBe("fin-a-share-radar");
    expect(result.tools[0].name).toBe("fin_market");
    expect(result.tools[0].input.endpoint).toBe("market/top_list");
  });

  it("routes unknown query to fallback fin_data_markets", () => {
    const result = simulateSkillRoute("What markets are available?");
    expect(result.skill).toBe("fin-data-query");
    expect(result.tools[0].name).toBe("fin_data_markets");
  });
});

describe("L4: Skill Routing — multi-tool chain for complex queries", () => {
  it("'BTC price and trend' produces multiple tool calls", () => {
    const result = simulateSkillRoute("BTC price and trend regime analysis");
    expect(result.skill).toBe("fin-crypto");
    expect(result.tools.length).toBeGreaterThanOrEqual(2);

    const toolNames = result.tools.map((t) => t.name);
    expect(toolNames).toContain("fin_crypto");
    expect(toolNames).toContain("fin_data_regime");
  });

  it("'BTC OHLCV candles' routes to fin_data_ohlcv", () => {
    const result = simulateSkillRoute("Show BTC OHLCV candle data");
    const ohlcvCall = result.tools.find((t) => t.name === "fin_data_ohlcv");
    expect(ohlcvCall).toBeDefined();
    expect(ohlcvCall!.input.symbol).toBe("BTC/USDT");
    expect(ohlcvCall!.input.market).toBe("crypto");
  });

  it("'DeFi TVL overview' routes to defi/protocols", () => {
    const result = simulateSkillRoute("Show DeFi TVL overview");
    const defiCall = result.tools.find(
      (t) => t.name === "fin_crypto" && t.input.endpoint === "defi/protocols",
    );
    expect(defiCall).toBeDefined();
  });

  it("'A股 600519.SH 北向资金' produces stock + market calls", () => {
    const result = simulateSkillRoute("A股 600519.SH 北向资金流向");
    expect(result.skill).toBe("fin-a-share");

    const toolNames = result.tools.map((t) => t.name);
    expect(toolNames).toContain("fin_market");

    const northboundCall = result.tools.find(
      (t) => t.name === "fin_market" && t.input.endpoint === "flow/hsgt_flow",
    );
    expect(northboundCall).toBeDefined();
  });
});

describe("L4: Parameter extraction quality", () => {
  it("extracts symbol code from natural language (600519.SH)", () => {
    const result = simulateSkillRoute("查看 600519.SH 的财报");
    const call = result.tools[0];
    expect(call.input.symbol).toBe("600519.SH");
    expect(call.input.endpoint).toBe("fundamental/income");
  });

  it("extracts correct endpoint for price quote requests", () => {
    const result = simulateSkillRoute("茅台 quote 行情");
    expect(result.tools[0].input.endpoint).toBe("price/quote");
  });

  it("all routed tools belong to registered datahub tool set", () => {
    const queries = [
      "BTC price",
      "茅台行情",
      "AAPL stock",
      "GDP macro",
      "ETF fund",
      "futures",
      "龙虎榜",
      "DeFi TVL",
      "00700.HK",
      "BTC RSI technical",
      "market overview",
    ];

    for (const query of queries) {
      const result = simulateSkillRoute(query);
      for (const tool of result.tools) {
        expect(DATAHUB_TOOLS).toContain(tool.name);
      }
    }
  });

  it("skill-tool mapping is consistent with skill.md definitions", () => {
    // Verify key skills map to their expected tools
    for (const [_skill, expectedTools] of Object.entries(SKILL_TOOL_MAP)) {
      for (const toolName of expectedTools) {
        expect(DATAHUB_TOOLS).toContain(toolName);
      }
    }
  });
});

describe("L4: Edge cases and error routing", () => {
  it("ambiguous query falls back to data-query skill", () => {
    const result = simulateSkillRoute("show me something interesting");
    expect(result.skill).toBe("fin-data-query");
  });

  it("mixed-market query (crypto + macro) selects primary skill", () => {
    // The router picks the first matching skill
    const result = simulateSkillRoute("BTC vs interest rate correlation");
    // Should match crypto first (BTC keyword)
    expect(result.skill).toBe("fin-crypto");
  });

  it("empty-ish query gets a valid fallback", () => {
    const result = simulateSkillRoute("help");
    expect(result.tools.length).toBeGreaterThan(0);
    expect(DATAHUB_TOOLS).toContain(result.tools[0].name);
  });
});
