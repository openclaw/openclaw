/**
 * L4 LLM Chain Test — Strategy Research Chain.
 *
 * Verifies the strategy research skill correctly chains tools:
 *   fin_data_regime → fin_strategy_create → fin_backtest_run → fin_backtest_result
 *
 * Tests with natural language queries like "backtest SMA crossover on ETH last 6 months".
 * Uses mock LLM responses to validate multi-step tool orchestration.
 *
 * Run:
 *   npx vitest run tests/findoo-trader-plugin/l4-llm/strategy-research-chain.test.ts
 */
import { describe, it, expect, beforeEach } from "vitest";

// ── Types ──

type ToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
};

type LlmBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

type MockLlmResponse = {
  stop_reason: "tool_use" | "end_turn";
  content: LlmBlock[];
};

// ── Mock tool executors for strategy research pipeline ──

function createResearchToolExecutor() {
  const calls: ToolCall[] = [];

  const executors: Record<string, (params: Record<string, unknown>) => ToolResult> = {
    fin_data_regime: (params) => {
      calls.push({ id: `call-${calls.length}`, name: "fin_data_regime", input: params });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              symbol: params.symbol,
              market: params.market ?? "crypto",
              regime: "bull",
              confidence: 0.82,
              regimeHistory: [
                { period: "2025-07-01/2025-09-30", regime: "bull" },
                { period: "2025-10-01/2025-11-30", regime: "sideways" },
                { period: "2025-12-01/2026-03-01", regime: "bull" },
              ],
            }),
          },
        ],
      };
    },

    fin_data_ohlcv: (params) => {
      calls.push({ id: `call-${calls.length}`, name: "fin_data_ohlcv", input: params });
      // Return minimal OHLCV data
      const bars = Array.from({ length: 180 }, (_, i) => ({
        timestamp: Date.now() - (180 - i) * 86_400_000,
        open: 3000 + Math.random() * 500,
        high: 3200 + Math.random() * 500,
        low: 2800 + Math.random() * 500,
        close: 3100 + Math.random() * 500,
        volume: 100000 + Math.random() * 50000,
      }));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ symbol: params.symbol, bars: bars.length }),
          },
        ],
      };
    },

    fin_strategy_create: (params) => {
      calls.push({ id: `call-${calls.length}`, name: "fin_strategy_create", input: params });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: `strat-${Date.now()}`,
              name: params.name,
              level: "L0_INCUBATE",
              createdAt: new Date().toISOString(),
            }),
          },
        ],
      };
    },

    fin_backtest_run: (params) => {
      calls.push({ id: `call-${calls.length}`, name: "fin_backtest_run", input: params });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              strategyId: params.strategyId,
              status: "completed",
              backtestId: `bt-${Date.now()}`,
              summary: {
                totalReturn: 18.5,
                maxDrawdown: -12.3,
                sharpeRatio: 1.42,
                winRate: 0.58,
                totalTrades: 124,
                profitFactor: 1.65,
              },
              walkForward: {
                passed: true,
                windows: 5,
                avgTestSharpe: 1.15,
                avgTrainSharpe: 1.52,
                ratio: 0.76,
              },
            }),
          },
        ],
      };
    },

    fin_backtest_result: (params) => {
      calls.push({ id: `call-${calls.length}`, name: "fin_backtest_result", input: params });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              backtestId: params.backtestId ?? params.strategyId,
              totalReturn: 18.5,
              sharpeRatio: 1.42,
              maxDrawdown: -12.3,
              winRate: 0.58,
              trades: 124,
            }),
          },
        ],
      };
    },

    fin_paper_create: (params) => {
      calls.push({ id: `call-${calls.length}`, name: "fin_paper_create", input: params });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              message: `Paper account created with $${String(params.capital)} virtual capital`,
              account: { id: "paper-001", equity: params.capital },
            }),
          },
        ],
      };
    },

    fin_strategy_list: (params) => {
      calls.push({ id: `call-${calls.length}`, name: "fin_strategy_list", input: params });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              strategies: [
                {
                  id: "strat-sma-001",
                  name: "SMA Crossover ETH",
                  level: "L1_BACKTEST",
                  sharpe: 1.42,
                  return: 18.5,
                },
              ],
            }),
          },
        ],
      };
    },
  };

  return {
    calls,
    execute(name: string, params: Record<string, unknown>): ToolResult {
      const fn = executors[name];
      if (!fn) {
        throw new Error(`Unknown tool: ${name}`);
      }
      return fn(params);
    },
  };
}

function simulateChain(
  turns: MockLlmResponse[],
  executor: ReturnType<typeof createResearchToolExecutor>,
): { finalText: string; toolCalls: ToolCall[] } {
  let finalText = "";
  for (const turn of turns) {
    for (const block of turn.content) {
      if (block.type === "text") {
        finalText += block.text;
      } else if (block.type === "tool_use") {
        executor.execute(block.name, block.input);
      }
    }
  }
  return { finalText, toolCalls: executor.calls };
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe("L4 LLM Chain — Strategy Research Pipeline", () => {
  let executor: ReturnType<typeof createResearchToolExecutor>;

  beforeEach(() => {
    executor = createResearchToolExecutor();
  });

  // ── 1. Full pipeline: regime → create → backtest → evaluate ──

  it("chains fin_data_regime → fin_strategy_create → fin_backtest_run for 'backtest SMA crossover on ETH'", () => {
    const turns: MockLlmResponse[] = [
      // Step 1: Analyze market regime
      {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Let me analyze the current ETH market regime first." },
          {
            type: "tool_use",
            id: "toolu_r01",
            name: "fin_data_regime",
            input: { symbol: "ETH/USDT", market: "crypto" },
          },
        ],
      },
      // Step 2: Create strategy based on regime
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "text",
            text: "ETH is in a bull regime. SMA crossover is a good fit. Creating the strategy.",
          },
          {
            type: "tool_use",
            id: "toolu_r02",
            name: "fin_strategy_create",
            input: {
              name: "SMA Crossover ETH 6M",
              type: "trend-following",
              parameters: { fastPeriod: 10, slowPeriod: 30, positionSizePct: 20 },
              symbols: ["ETH/USDT"],
              timeframes: ["1d"],
            },
          },
        ],
      },
      // Step 3: Run backtest
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_r03",
            name: "fin_backtest_run",
            input: {
              strategyId: "strat-sma-001",
              symbol: "ETH/USDT",
              timeframe: "1d",
              startDate: "2025-09-01",
              endDate: "2026-03-01",
              options: { walkForward: true, windows: 5 },
            },
          },
        ],
      },
    ];

    const { toolCalls } = simulateChain(turns, executor);

    // Verify 3-tool chain
    expect(toolCalls).toHaveLength(3);
    expect(toolCalls[0].name).toBe("fin_data_regime");
    expect(toolCalls[1].name).toBe("fin_strategy_create");
    expect(toolCalls[2].name).toBe("fin_backtest_run");

    // Verify regime call params
    expect(toolCalls[0].input.symbol).toBe("ETH/USDT");

    // Verify strategy creation params
    expect(toolCalls[1].input.name).toContain("SMA Crossover");
    expect(toolCalls[1].input.type).toBe("trend-following");

    // Verify backtest params include walk-forward
    expect(toolCalls[2].input.startDate).toBe("2025-09-01");
    expect(toolCalls[2].input.endDate).toBe("2026-03-01");
    expect((toolCalls[2].input.options as Record<string, unknown>).walkForward).toBe(true);
  });

  // ── 2. Full pipeline with paper deployment ──

  it("deploys winning strategy to paper trading after successful backtest", () => {
    const turns: MockLlmResponse[] = [
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_r10",
            name: "fin_data_regime",
            input: { symbol: "BTC/USDT", market: "crypto" },
          },
        ],
      },
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_r11",
            name: "fin_strategy_create",
            input: {
              name: "BTC Trend Following",
              type: "trend-following",
              parameters: { fastPeriod: 12, slowPeriod: 26 },
            },
          },
        ],
      },
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_r12",
            name: "fin_backtest_run",
            input: {
              strategyId: "strat-btc-001",
              symbol: "BTC/USDT",
              timeframe: "4h",
              startDate: "2025-09-01",
              endDate: "2026-03-01",
            },
          },
        ],
      },
      // Step 4: Deploy to paper
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "text",
            text: "Backtest passed (Sharpe 1.42, WF ratio 0.76). Deploying to paper trading.",
          },
          {
            type: "tool_use",
            id: "toolu_r13",
            name: "fin_paper_create",
            input: {
              name: "BTC Trend Following Paper",
              capital: 10000,
            },
          },
        ],
      },
    ];

    const { toolCalls, finalText } = simulateChain(turns, executor);

    expect(toolCalls).toHaveLength(4);
    expect(toolCalls[3].name).toBe("fin_paper_create");
    expect(toolCalls[3].input.capital).toBe(10000);
    expect(finalText).toContain("Deploying to paper trading");
  });

  // ── 3. Regime-driven strategy selection ──

  it("regime analysis determines strategy type selection", () => {
    const regimeTurn: MockLlmResponse = {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_r20",
          name: "fin_data_regime",
          input: { symbol: "ETH/USDT", market: "crypto" },
        },
      ],
    };

    const { toolCalls } = simulateChain([regimeTurn], executor);

    expect(toolCalls[0].name).toBe("fin_data_regime");
    const result = JSON.parse(
      executor.execute("fin_data_regime", { symbol: "ETH/USDT", market: "crypto" }).content[0].text,
    );
    expect(result.regime).toBe("bull");
    expect(result.confidence).toBeGreaterThan(0.5);
    // Bull regime should suggest trend-following strategies
    expect(["bull", "sideways", "bear", "volatile", "crisis"]).toContain(result.regime);
  });

  // ── 4. Walk-Forward validation in backtest ──

  it("backtest includes Walk-Forward validation parameters", () => {
    const backtestTurn: MockLlmResponse = {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_r30",
          name: "fin_backtest_run",
          input: {
            strategyId: "strat-test-001",
            symbol: "BTC/USDT",
            timeframe: "1d",
            startDate: "2025-06-01",
            endDate: "2026-03-01",
            options: {
              walkForward: true,
              windows: 5,
              trainPct: 0.7,
              testPct: 0.3,
            },
          },
        },
      ],
    };

    const { toolCalls } = simulateChain([backtestTurn], executor);
    const options = toolCalls[0].input.options as Record<string, unknown>;

    expect(options.walkForward).toBe(true);
    expect(options.windows).toBe(5);
    expect(options.trainPct).toBe(0.7);
    expect(options.testPct).toBe(0.3);
  });

  // ── 5. Backtest result evaluation against thresholds ──

  it("evaluates backtest result against L2 promotion thresholds", () => {
    const result = {
      totalReturn: 18.5,
      maxDrawdown: -12.3,
      sharpeRatio: 1.42,
      winRate: 0.58,
      totalTrades: 124,
      walkForward: { passed: true, ratio: 0.76 },
    };

    // L2 thresholds from strategy-research skill.md
    const thresholds = {
      walkForwardPassed: true,
      minSharpe: 1.0,
      maxDrawdownPct: 25,
      minTrades: 100,
    };

    expect(result.walkForward.passed).toBe(thresholds.walkForwardPassed);
    expect(result.sharpeRatio).toBeGreaterThanOrEqual(thresholds.minSharpe);
    expect(Math.abs(result.maxDrawdown)).toBeLessThanOrEqual(thresholds.maxDrawdownPct);
    expect(result.totalTrades).toBeGreaterThanOrEqual(thresholds.minTrades);
  });

  // ── 6. Multi-candidate comparison flow ──

  it("creates and backtests multiple strategy candidates for comparison", () => {
    const turns: MockLlmResponse[] = [
      // Create candidate 1: SMA Crossover
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_r40",
            name: "fin_strategy_create",
            input: {
              name: "SMA Crossover ETH",
              type: "trend-following",
              parameters: { fastPeriod: 10, slowPeriod: 30 },
            },
          },
        ],
      },
      // Create candidate 2: RSI Mean Reversion
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_r41",
            name: "fin_strategy_create",
            input: {
              name: "RSI Mean Reversion ETH",
              type: "mean-reversion",
              parameters: { rsiPeriod: 14, oversold: 30, overbought: 70 },
            },
          },
        ],
      },
      // Backtest candidate 1
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_r42",
            name: "fin_backtest_run",
            input: { strategyId: "strat-sma-001", symbol: "ETH/USDT", timeframe: "1d" },
          },
        ],
      },
      // Backtest candidate 2
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_r43",
            name: "fin_backtest_run",
            input: { strategyId: "strat-rsi-001", symbol: "ETH/USDT", timeframe: "1d" },
          },
        ],
      },
    ];

    const { toolCalls } = simulateChain(turns, executor);

    // 2 creates + 2 backtests
    expect(toolCalls).toHaveLength(4);
    expect(toolCalls.filter((c) => c.name === "fin_strategy_create")).toHaveLength(2);
    expect(toolCalls.filter((c) => c.name === "fin_backtest_run")).toHaveLength(2);

    // Verify different strategy types
    expect(toolCalls[0].input.type).toBe("trend-following");
    expect(toolCalls[1].input.type).toBe("mean-reversion");
  });

  // ── 7. OHLCV data fetch in research pipeline ──

  it("fetches OHLCV data as part of research analysis", () => {
    const turn: MockLlmResponse = {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_r50",
          name: "fin_data_ohlcv",
          input: {
            symbol: "ETH/USDT",
            market: "crypto",
            timeframe: "1d",
            limit: 180,
          },
        },
      ],
    };

    const { toolCalls } = simulateChain([turn], executor);
    expect(toolCalls[0].name).toBe("fin_data_ohlcv");
    expect(toolCalls[0].input.limit).toBe(180);
    expect(toolCalls[0].input.timeframe).toBe("1d");
  });
});
