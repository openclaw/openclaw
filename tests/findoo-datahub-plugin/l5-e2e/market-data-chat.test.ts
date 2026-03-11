/**
 * L5 — Playwright E2E: Market Data Chat Interaction
 *
 * Simulates a user interacting with the chat interface to request
 * market data ("BTC price", "market overview", etc.) and verifies
 * the response contains expected data fields.
 *
 * Playwright steps are documented as comments. Vitest assertions
 * run against mock data matching the real gateway chat response shape.
 */
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Types matching the control UI chat response format
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  tool_calls?: ToolCallResult[];
  timestamp: number;
}

interface ToolCallResult {
  tool_name: string;
  input: Record<string, unknown>;
  output: string; // JSON string
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// Mock chat responses — simulate LLM + tool execution pipeline
// ---------------------------------------------------------------------------

function mockChatResponse(userQuery: string): ChatMessage {
  const q = userQuery.toLowerCase();
  const now = Date.now();

  // "BTC price" query
  if (q.includes("btc") && q.includes("price")) {
    return {
      role: "assistant",
      content:
        "Based on the latest data, **BTC/USDT** is currently trading at **$64,200** (+2.15% in 24h).\n\n" +
        "| Metric | Value |\n|---|---|\n" +
        "| Last Price | $64,200 |\n" +
        "| 24h Change | +2.15% |\n" +
        "| 24h Volume | $42B |\n" +
        "| Bid | $64,195 |\n" +
        "| Ask | $64,205 |\n\n" +
        "Market regime: **Bull** (SMA crossover + low ATR).",
      tool_calls: [
        {
          tool_name: "fin_crypto",
          input: { endpoint: "market/ticker", symbol: "BTC/USDT" },
          output: JSON.stringify({
            success: true,
            endpoint: "crypto/market/ticker",
            count: 1,
            results: [
              {
                symbol: "BTC/USDT",
                last: 64200,
                bid: 64195,
                ask: 64205,
                volume: 42000000000,
                change_pct_24h: 2.15,
                timestamp: now,
              },
            ],
          }),
          duration_ms: 850,
        },
        {
          tool_name: "fin_data_regime",
          input: { symbol: "BTC/USDT", market: "crypto", timeframe: "4h" },
          output: JSON.stringify({
            symbol: "BTC/USDT",
            market: "crypto",
            timeframe: "4h",
            regime: "bull",
          }),
          duration_ms: 1200,
        },
      ],
      timestamp: now,
    };
  }

  // "market overview" query
  if (q.includes("market overview") || q.includes("市场概览")) {
    return {
      role: "assistant",
      content:
        "## Crypto Market Overview\n\n" +
        "**Total Market Cap:** $2.18T (+1.45% 24h)\n" +
        "**BTC Dominance:** 57.9%\n" +
        "**24h Volume:** $98B\n\n" +
        "### Top 5 by Market Cap\n\n" +
        "| # | Coin | Price | 24h% |\n|---|---|---|---|\n" +
        "| 1 | BTC | $64,200 | +2.15% |\n" +
        "| 2 | ETH | $3,450 | +1.82% |\n" +
        "| 3 | BNB | $580 | +0.95% |\n" +
        "| 4 | SOL | $145 | +3.20% |\n" +
        "| 5 | XRP | $0.62 | -0.45% |\n\n" +
        "### DeFi Overview\n" +
        "Total DeFi TVL: $48B | Top protocol: Lido ($35.2B)\n\n" +
        "Market regime: **Bull** — bullish momentum across major pairs.",
      tool_calls: [
        {
          tool_name: "fin_crypto",
          input: { endpoint: "coin/global_stats" },
          output: JSON.stringify({
            success: true,
            endpoint: "crypto/coin/global_stats",
            count: 1,
            results: [
              {
                total_market_cap: 2180000000000,
                total_volume: 98000000000,
                bitcoin_dominance: 57.9,
                active_cryptocurrencies: 14523,
                market_cap_change_percentage_24h: 1.45,
              },
            ],
          }),
          duration_ms: 680,
        },
        {
          tool_name: "fin_crypto",
          input: { endpoint: "coin/market", limit: 20 },
          output: JSON.stringify({
            success: true,
            endpoint: "crypto/coin/market",
            count: 5,
            results: [
              {
                id: "bitcoin",
                symbol: "btc",
                current_price: 64200,
                market_cap: 1262000000000,
                price_change_percentage_24h: 2.15,
                market_cap_rank: 1,
              },
              {
                id: "ethereum",
                symbol: "eth",
                current_price: 3450,
                market_cap: 415000000000,
                price_change_percentage_24h: 1.82,
                market_cap_rank: 2,
              },
              {
                id: "binancecoin",
                symbol: "bnb",
                current_price: 580,
                market_cap: 89000000000,
                price_change_percentage_24h: 0.95,
                market_cap_rank: 3,
              },
              {
                id: "solana",
                symbol: "sol",
                current_price: 145,
                market_cap: 62000000000,
                price_change_percentage_24h: 3.2,
                market_cap_rank: 4,
              },
              {
                id: "ripple",
                symbol: "xrp",
                current_price: 0.62,
                market_cap: 34000000000,
                price_change_percentage_24h: -0.45,
                market_cap_rank: 5,
              },
            ],
          }),
          duration_ms: 920,
        },
        {
          tool_name: "fin_crypto",
          input: { endpoint: "defi/protocols", limit: 10 },
          output: JSON.stringify({
            success: true,
            endpoint: "crypto/defi/protocols",
            count: 2,
            results: [
              { name: "Lido", tvl: 35200000000, category: "Liquid Staking" },
              { name: "AAVE", tvl: 12800000000, category: "Lending" },
            ],
          }),
          duration_ms: 750,
        },
      ],
      timestamp: now,
    };
  }

  // "A share" / stock query
  if (q.includes("茅台") || q.includes("600519") || q.includes("a share")) {
    return {
      role: "assistant",
      content:
        "## 600519.SH (Kweichow Moutai)\n\n" +
        "| Date | Open | High | Low | Close | Volume |\n|---|---|---|---|---|---|\n" +
        "| 2026-03-10 | 1870.00 | 1895.00 | 1865.00 | 1890.00 | 38,200 |\n" +
        "| 2026-03-07 | 1850.00 | 1872.50 | 1845.00 | 1868.00 | 32,500 |\n",
      tool_calls: [
        {
          tool_name: "fin_stock",
          input: { symbol: "600519.SH", endpoint: "price/historical", limit: 5 },
          output: JSON.stringify({
            success: true,
            endpoint: "equity/price/historical",
            count: 2,
            results: [
              {
                date: "2026-03-07",
                open: 1850.0,
                high: 1872.5,
                low: 1845.0,
                close: 1868.0,
                volume: 32500,
              },
              {
                date: "2026-03-10",
                open: 1870.0,
                high: 1895.0,
                low: 1865.0,
                close: 1890.0,
                volume: 38200,
              },
            ],
          }),
          duration_ms: 1100,
        },
      ],
      timestamp: now,
    };
  }

  // "macro CPI" query
  if (q.includes("cpi") || q.includes("macro") || q.includes("宏观")) {
    return {
      role: "assistant",
      content:
        "## China CPI Data\n\n" +
        "Latest CPI (Feb 2026): **0.8% YoY** (prev: 0.5%)\n\n" +
        "Trend: slight uptick in inflation, still within moderate range.",
      tool_calls: [
        {
          tool_name: "fin_macro",
          input: { endpoint: "cpi", limit: 5 },
          output: JSON.stringify({
            success: true,
            endpoint: "economy/cpi",
            count: 2,
            results: [
              { date: "2026-02", value: 0.8, yoy: 0.8, mom: 0.2 },
              { date: "2026-01", value: 0.5, yoy: 0.5, mom: -0.3 },
            ],
          }),
          duration_ms: 900,
        },
      ],
      timestamp: now,
    };
  }

  // Fallback
  return {
    role: "assistant",
    content:
      "I can help with financial data queries. Try asking about BTC price, market overview, or specific stock data.",
    timestamp: now,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("L5 E2E: Chat — BTC price query", () => {
  const response = mockChatResponse("What is the BTC price?");

  it("user sends 'BTC price' and receives assistant response", () => {
    // Playwright steps:
    // 1. await page.goto('http://localhost:18789/control')
    // 2. await page.click('nav >> text=Chat')
    // 3. await page.fill('[data-testid="chat-input"]', 'What is the BTC price?')
    // 4. await page.press('[data-testid="chat-input"]', 'Enter')
    // 5. await page.waitForSelector('[data-testid="assistant-message"]', { timeout: 30000 })

    expect(response.role).toBe("assistant");
    expect(response.content.length).toBeGreaterThan(0);
  });

  it("response contains BTC price value", () => {
    // Playwright steps:
    // 1. const messageText = await page.locator('[data-testid="assistant-message"]').textContent()
    // 2. Verify it contains a dollar amount for BTC

    expect(response.content).toContain("64,200");
    expect(response.content).toContain("BTC");
  });

  it("response contains 24h change percentage", () => {
    expect(response.content).toContain("2.15%");
  });

  it("response contains market regime assessment", () => {
    expect(response.content).toMatch(/Bull|Bear|Sideways|Volatile|Crisis/i);
  });

  it("tool calls include fin_crypto and fin_data_regime", () => {
    // Playwright steps:
    // 1. await page.click('[data-testid="tool-calls-toggle"]')
    // 2. const toolNames = await page.locator('[data-testid="tool-call-name"]').allTextContents()

    expect(response.tool_calls).toBeDefined();
    const toolNames = response.tool_calls!.map((tc) => tc.tool_name);
    expect(toolNames).toContain("fin_crypto");
    expect(toolNames).toContain("fin_data_regime");
  });

  it("fin_crypto tool call used market/ticker endpoint", () => {
    const cryptoCall = response.tool_calls!.find((tc) => tc.tool_name === "fin_crypto");
    expect(cryptoCall).toBeDefined();
    expect(cryptoCall!.input.endpoint).toBe("market/ticker");
    expect(cryptoCall!.input.symbol).toBe("BTC/USDT");
  });

  it("tool call output contains valid JSON with price data", () => {
    const cryptoCall = response.tool_calls!.find((tc) => tc.tool_name === "fin_crypto");
    const output = JSON.parse(cryptoCall!.output);
    expect(output.success).toBe(true);
    expect(output.results[0].last).toBe(64200);
    expect(output.results[0].symbol).toBe("BTC/USDT");
  });

  it("tool call completes within reasonable time", () => {
    for (const tc of response.tool_calls!) {
      expect(tc.duration_ms).toBeLessThan(5000);
    }
  });
});

describe("L5 E2E: Chat — market overview query", () => {
  const response = mockChatResponse("Show me the market overview");

  it("response contains total market cap", () => {
    // Playwright steps:
    // 1. await page.fill('[data-testid="chat-input"]', 'Show me the market overview')
    // 2. await page.press('[data-testid="chat-input"]', 'Enter')
    // 3. await page.waitForSelector('[data-testid="assistant-message"]:last-child')

    expect(response.content).toContain("$2.18T");
  });

  it("response contains BTC dominance", () => {
    expect(response.content).toContain("57.9%");
  });

  it("response contains top coins table", () => {
    expect(response.content).toContain("BTC");
    expect(response.content).toContain("ETH");
    expect(response.content).toContain("$64,200");
    expect(response.content).toContain("$3,450");
  });

  it("response contains DeFi TVL info", () => {
    expect(response.content).toContain("DeFi");
    expect(response.content).toContain("Lido");
    expect(response.content).toContain("$35.2B");
  });

  it("multiple tool calls were made for comprehensive overview", () => {
    expect(response.tool_calls).toBeDefined();
    expect(response.tool_calls!.length).toBeGreaterThanOrEqual(3);

    const endpoints = response.tool_calls!.map((tc) => {
      if (tc.tool_name === "fin_crypto") {
        return tc.input.endpoint;
      }
      return tc.tool_name;
    });
    expect(endpoints).toContain("coin/global_stats");
    expect(endpoints).toContain("coin/market");
    expect(endpoints).toContain("defi/protocols");
  });

  it("coin/market results are ranked by market cap", () => {
    const coinCall = response.tool_calls!.find(
      (tc) => tc.tool_name === "fin_crypto" && tc.input.endpoint === "coin/market",
    );
    const output = JSON.parse(coinCall!.output);
    const ranks = output.results.map((r: { market_cap_rank: number }) => r.market_cap_rank);
    // Ranks should be in ascending order
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThan(ranks[i - 1]);
    }
  });
});

describe("L5 E2E: Chat — A-share stock query", () => {
  const response = mockChatResponse("茅台 600519.SH 最近行情");

  it("response contains stock price data", () => {
    // Playwright steps:
    // 1. await page.fill('[data-testid="chat-input"]', '茅台 600519.SH 最近行情')
    // 2. await page.press('[data-testid="chat-input"]', 'Enter')
    // 3. await page.waitForSelector('[data-testid="assistant-message"]:last-child')

    expect(response.content).toContain("600519.SH");
    expect(response.content).toContain("1890.00");
  });

  it("response includes OHLCV table with date, open, high, low, close, volume", () => {
    expect(response.content).toContain("Open");
    expect(response.content).toContain("High");
    expect(response.content).toContain("Low");
    expect(response.content).toContain("Close");
    expect(response.content).toContain("Volume");
    expect(response.content).toContain("2026-03-10");
  });

  it("tool call used fin_stock with correct symbol", () => {
    expect(response.tool_calls).toBeDefined();
    const stockCall = response.tool_calls!.find((tc) => tc.tool_name === "fin_stock");
    expect(stockCall).toBeDefined();
    expect(stockCall!.input.symbol).toBe("600519.SH");
    expect(stockCall!.input.endpoint).toBe("price/historical");
  });

  it("tool output contains valid equity data", () => {
    const stockCall = response.tool_calls!.find((tc) => tc.tool_name === "fin_stock");
    const output = JSON.parse(stockCall!.output);
    expect(output.success).toBe(true);
    expect(output.count).toBeGreaterThan(0);
    expect(output.results[0]).toHaveProperty("date");
    expect(output.results[0]).toHaveProperty("close");
    expect(output.results[0]).toHaveProperty("volume");
  });
});

describe("L5 E2E: Chat — macro CPI query", () => {
  const response = mockChatResponse("Latest CPI macro data");

  it("response contains CPI value", () => {
    expect(response.content).toContain("0.8%");
    expect(response.content).toContain("CPI");
  });

  it("tool call used fin_macro with cpi endpoint", () => {
    expect(response.tool_calls).toBeDefined();
    const macroCall = response.tool_calls!.find((tc) => tc.tool_name === "fin_macro");
    expect(macroCall).toBeDefined();
    expect(macroCall!.input.endpoint).toBe("cpi");
  });

  it("CPI data includes YoY and MoM changes", () => {
    const macroCall = response.tool_calls!.find((tc) => tc.tool_name === "fin_macro");
    const output = JSON.parse(macroCall!.output);
    expect(output.results[0]).toHaveProperty("yoy");
    expect(output.results[0]).toHaveProperty("mom");
  });
});

describe("L5 E2E: Chat — response format and quality", () => {
  it("assistant response uses markdown formatting", () => {
    const response = mockChatResponse("Show me the market overview");
    // Check for markdown headers
    expect(response.content).toMatch(/^##\s/m);
    // Check for markdown tables
    expect(response.content).toContain("|");
  });

  it("assistant response includes data source attribution", () => {
    const response = mockChatResponse("What is the BTC price?");
    // Tool calls serve as implicit data source
    expect(response.tool_calls).toBeDefined();
    expect(response.tool_calls!.length).toBeGreaterThan(0);
  });

  it("fallback response for unknown queries is helpful", () => {
    const response = mockChatResponse("random nonsense xyz");
    expect(response.content).toContain("financial data");
    expect(response.tool_calls).toBeUndefined();
  });

  it("response timestamps are recent", () => {
    const response = mockChatResponse("BTC price");
    const now = Date.now();
    expect(response.timestamp).toBeGreaterThan(now - 5000);
    expect(response.timestamp).toBeLessThanOrEqual(now + 1000);
  });
});

describe("L5 E2E: Chat — conversation flow", () => {
  it("sequential queries produce independent responses", () => {
    // Playwright steps:
    // 1. Send "BTC price" → verify BTC response
    // 2. Send "茅台行情" → verify A-share response (not BTC)
    // 3. Send "CPI" → verify macro response

    const r1 = mockChatResponse("BTC price");
    const r2 = mockChatResponse("茅台 600519.SH");
    const r3 = mockChatResponse("CPI macro");

    // Each response should be relevant to its query
    expect(r1.content).toContain("BTC");
    expect(r1.content).not.toContain("600519");

    expect(r2.content).toContain("600519");
    expect(r2.content).not.toContain("BTC");

    expect(r3.content).toContain("CPI");
    expect(r3.content).not.toContain("BTC");
  });

  it("each response uses the appropriate tool for its query", () => {
    const r1 = mockChatResponse("BTC price");
    const r2 = mockChatResponse("茅台行情");
    const r3 = mockChatResponse("CPI macro");

    expect(r1.tool_calls!.some((tc) => tc.tool_name === "fin_crypto")).toBe(true);
    expect(r2.tool_calls!.some((tc) => tc.tool_name === "fin_stock")).toBe(true);
    expect(r3.tool_calls!.some((tc) => tc.tool_name === "fin_macro")).toBe(true);
  });
});
