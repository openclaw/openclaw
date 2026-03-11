/**
 * L4 LLM Chain Test — Fund Management Chain.
 *
 * Verifies fund management queries route to the correct tools:
 *   "Show fund status" → fin_fund_status
 *   "Rebalance portfolio" → fin_fund_rebalance
 *   "Show leaderboard" → fin_leaderboard
 *   "Check promotion" → fin_fund_promote
 *   "Fund risk level" → fin_fund_risk
 *
 * Tests multi-step chains including rebalance → leaderboard → promote.
 *
 * Run:
 *   npx vitest run tests/findoo-trader-plugin/l4-llm/fund-management-chain.test.ts
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

// ── Mock fund tool executors ──

function createFundToolExecutor() {
  const calls: ToolCall[] = [];

  const executors: Record<string, (params: Record<string, unknown>) => ToolResult> = {
    fin_fund_status: (params) => {
      calls.push({ id: `call-${calls.length}`, name: "fin_fund_status", input: params });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              totalCapital: 100000,
              totalEquity: 105200,
              allocations: [
                { strategyId: "sma-001", weightPct: 25, capitalUsd: 25000 },
                { strategyId: "rsi-002", weightPct: 15, capitalUsd: 15000 },
              ],
              allocationCount: 2,
              totalStrategies: 5,
              byLevel: { L0_INCUBATE: 1, L1_BACKTEST: 1, L2_PAPER: 2, L3_LIVE: 1, KILLED: 0 },
              risk: { riskLevel: "normal", dailyDrawdownPct: -0.5 },
              lastRebalanceAt: "2026-03-10T08:00:00.000Z",
            }),
          },
        ],
      };
    },

    fin_fund_allocate: (params) => {
      calls.push({ id: `call-${calls.length}`, name: "fin_fund_allocate", input: params });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              allocations: [
                { strategyId: "sma-001", weightPct: 28, capitalUsd: 28000 },
                { strategyId: "rsi-002", weightPct: 18, capitalUsd: 18000 },
                { strategyId: "macd-003", weightPct: 12, capitalUsd: 12000 },
              ],
              totalAllocated: 58000,
              cashReserve: 42000,
            }),
          },
        ],
      };
    },

    fin_fund_rebalance: (params) => {
      calls.push({ id: `call-${calls.length}`, name: "fin_fund_rebalance", input: params });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              allocations: [
                { strategyId: "sma-001", weightPct: 28, capitalUsd: 28000 },
                { strategyId: "rsi-002", weightPct: 18, capitalUsd: 18000 },
              ],
              leaderboard: [
                { rank: 1, strategyId: "sma-001", fitness: 0.85 },
                { rank: 2, strategyId: "rsi-002", fitness: 0.72 },
              ],
              risk: { riskLevel: "normal", dailyDrawdownPct: -0.3 },
              promotions: [{ strategyId: "macd-003", targetLevel: "L2_PAPER", eligible: true }],
              demotions: [],
              pendingConfirmations: [],
            }),
          },
        ],
      };
    },

    fin_leaderboard: (params) => {
      calls.push({ id: `call-${calls.length}`, name: "fin_leaderboard", input: params });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              leaderboard: [
                {
                  rank: 1,
                  strategyId: "sma-001",
                  name: "SMA Crossover BTC",
                  fitness: 0.85,
                  sharpe: 1.6,
                  level: "L3_LIVE",
                },
                {
                  rank: 2,
                  strategyId: "rsi-002",
                  name: "RSI Mean Rev ETH",
                  fitness: 0.72,
                  sharpe: 1.2,
                  level: "L2_PAPER",
                },
                {
                  rank: 3,
                  strategyId: "macd-003",
                  name: "MACD Divergence",
                  fitness: 0.55,
                  sharpe: 0.8,
                  level: "L1_BACKTEST",
                },
              ],
              total: 3,
            }),
          },
        ],
      };
    },

    fin_fund_promote: (params) => {
      calls.push({ id: `call-${calls.length}`, name: "fin_fund_promote", input: params });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              strategyId: params.strategyId,
              eligible: true,
              currentLevel: "L2_PAPER",
              targetLevel: "L3_LIVE",
              needsUserConfirmation: true,
              criteria: {
                minDays: { required: 30, actual: 45, passed: true },
                minSharpe: { required: 1.5, actual: 1.8, passed: true },
                maxDrawdown: { required: -0.1, actual: -0.07, passed: true },
                minTrades: { required: 50, actual: 68, passed: true },
              },
            }),
          },
        ],
      };
    },

    fin_fund_risk: (params) => {
      calls.push({ id: `call-${calls.length}`, name: "fin_fund_risk", input: params });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              riskLevel: "normal",
              dailyDrawdownPct: -0.5,
              totalExposurePct: 58,
              scaleFactor: 1.0,
              actions: ["Normal operations"],
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
                { id: "sma-001", name: "SMA Crossover BTC", level: "L3_LIVE" },
                { id: "rsi-002", name: "RSI Mean Rev ETH", level: "L2_PAPER" },
              ],
            }),
          },
        ],
      };
    },

    fin_lifecycle_scan: (params) => {
      calls.push({ id: `call-${calls.length}`, name: "fin_lifecycle_scan", input: params });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              actions: [
                {
                  strategyId: "rsi-002",
                  action: "approve_promotion",
                  detail: "Eligible for L3_LIVE (needs user confirmation)",
                  tool: "fin_fund_rebalance with confirmed_promotions",
                },
              ],
              summary: { totalStrategies: 5, actionableCount: 1, riskLevel: "normal" },
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
  executor: ReturnType<typeof createFundToolExecutor>,
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

describe("L4 LLM Chain — Fund Status Queries", () => {
  let executor: ReturnType<typeof createFundToolExecutor>;

  beforeEach(() => {
    executor = createFundToolExecutor();
  });

  it("'Show fund status' → fin_fund_status", () => {
    const turn: MockLlmResponse = {
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "Let me check your fund status." },
        {
          type: "tool_use",
          id: "toolu_f01",
          name: "fin_fund_status",
          input: {},
        },
      ],
    };

    const { toolCalls } = simulateChain([turn], executor);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("fin_fund_status");
  });

  it("'What is my fund risk level' → fin_fund_risk", () => {
    const turn: MockLlmResponse = {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_f02",
          name: "fin_fund_risk",
          input: {},
        },
      ],
    };

    const { toolCalls } = simulateChain([turn], executor);
    expect(toolCalls[0].name).toBe("fin_fund_risk");
  });

  it("'Show strategy leaderboard' → fin_leaderboard", () => {
    const turn: MockLlmResponse = {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_f03",
          name: "fin_leaderboard",
          input: {},
        },
      ],
    };

    const { toolCalls } = simulateChain([turn], executor);
    expect(toolCalls[0].name).toBe("fin_leaderboard");
  });

  it("'Show L2 paper strategies only' → fin_leaderboard with level filter", () => {
    const turn: MockLlmResponse = {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_f04",
          name: "fin_leaderboard",
          input: { level: "L2_PAPER" },
        },
      ],
    };

    const { toolCalls } = simulateChain([turn], executor);
    expect(toolCalls[0].input.level).toBe("L2_PAPER");
  });
});

describe("L4 LLM Chain — Rebalance Flow", () => {
  let executor: ReturnType<typeof createFundToolExecutor>;

  beforeEach(() => {
    executor = createFundToolExecutor();
  });

  it("'Rebalance portfolio' → fin_fund_rebalance", () => {
    const turn: MockLlmResponse = {
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "Initiating a full portfolio rebalance." },
        {
          type: "tool_use",
          id: "toolu_f10",
          name: "fin_fund_rebalance",
          input: {},
        },
      ],
    };

    const { toolCalls } = simulateChain([turn], executor);
    expect(toolCalls[0].name).toBe("fin_fund_rebalance");
  });

  it("rebalance with confirmed L3 promotions passes strategy IDs", () => {
    const turn: MockLlmResponse = {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_f11",
          name: "fin_fund_rebalance",
          input: {
            confirmed_promotions: ["rsi-002"],
          },
        },
      ],
    };

    const { toolCalls } = simulateChain([turn], executor);
    expect(toolCalls[0].input.confirmed_promotions).toEqual(["rsi-002"]);
  });
});

describe("L4 LLM Chain — Promotion Check Flow", () => {
  let executor: ReturnType<typeof createFundToolExecutor>;

  beforeEach(() => {
    executor = createFundToolExecutor();
  });

  it("'Can rsi-002 be promoted?' → fin_fund_promote with strategyId", () => {
    const turn: MockLlmResponse = {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_f20",
          name: "fin_fund_promote",
          input: { strategyId: "rsi-002" },
        },
      ],
    };

    const { toolCalls } = simulateChain([turn], executor);
    expect(toolCalls[0].name).toBe("fin_fund_promote");
    expect(toolCalls[0].input.strategyId).toBe("rsi-002");
  });

  it("promotion check response includes criteria breakdown", () => {
    const result = JSON.parse(
      createFundToolExecutor().execute("fin_fund_promote", { strategyId: "rsi-002" }).content[0]
        .text,
    );

    expect(result.eligible).toBe(true);
    expect(result.needsUserConfirmation).toBe(true);
    expect(result.targetLevel).toBe("L3_LIVE");
    expect(result.criteria.minDays.passed).toBe(true);
    expect(result.criteria.minSharpe.passed).toBe(true);
    expect(result.criteria.maxDrawdown.passed).toBe(true);
    expect(result.criteria.minTrades.passed).toBe(true);
  });
});

describe("L4 LLM Chain — Multi-step Fund Management", () => {
  let executor: ReturnType<typeof createFundToolExecutor>;

  beforeEach(() => {
    executor = createFundToolExecutor();
  });

  it("full chain: status → leaderboard → promote → rebalance", () => {
    const turns: MockLlmResponse[] = [
      // Step 1: Check status
      {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Let me review the fund status first." },
          { type: "tool_use", id: "toolu_f30", name: "fin_fund_status", input: {} },
        ],
      },
      // Step 2: View leaderboard
      {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Now let me check the strategy rankings." },
          { type: "tool_use", id: "toolu_f31", name: "fin_leaderboard", input: {} },
        ],
      },
      // Step 3: Check promotion eligibility
      {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "RSI strategy looks ready for promotion. Checking eligibility." },
          {
            type: "tool_use",
            id: "toolu_f32",
            name: "fin_fund_promote",
            input: { strategyId: "rsi-002" },
          },
        ],
      },
      // Step 4: Rebalance with promotion
      {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Executing rebalance with confirmed promotion." },
          {
            type: "tool_use",
            id: "toolu_f33",
            name: "fin_fund_rebalance",
            input: { confirmed_promotions: ["rsi-002"] },
          },
        ],
      },
    ];

    const { toolCalls } = simulateChain(turns, executor);

    expect(toolCalls).toHaveLength(4);
    expect(toolCalls[0].name).toBe("fin_fund_status");
    expect(toolCalls[1].name).toBe("fin_leaderboard");
    expect(toolCalls[2].name).toBe("fin_fund_promote");
    expect(toolCalls[3].name).toBe("fin_fund_rebalance");
    expect(toolCalls[3].input.confirmed_promotions).toEqual(["rsi-002"]);
  });

  it("lifecycle scan → targeted rebalance chain", () => {
    const turns: MockLlmResponse[] = [
      {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Scanning for lifecycle actions." },
          { type: "tool_use", id: "toolu_f40", name: "fin_lifecycle_scan", input: {} },
        ],
      },
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "text",
            text: "Found 1 strategy ready for promotion. Executing rebalance.",
          },
          {
            type: "tool_use",
            id: "toolu_f41",
            name: "fin_fund_rebalance",
            input: { confirmed_promotions: ["rsi-002"] },
          },
        ],
      },
    ];

    const { toolCalls } = simulateChain(turns, executor);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].name).toBe("fin_lifecycle_scan");
    expect(toolCalls[1].name).toBe("fin_fund_rebalance");
  });

  it("risk-aware rebalance: check risk first, then rebalance", () => {
    const turns: MockLlmResponse[] = [
      {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_f50", name: "fin_fund_risk", input: {} }],
      },
      {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Risk level normal. Safe to rebalance." },
          { type: "tool_use", id: "toolu_f51", name: "fin_fund_rebalance", input: {} },
        ],
      },
    ];

    const { toolCalls } = simulateChain(turns, executor);
    expect(toolCalls[0].name).toBe("fin_fund_risk");
    expect(toolCalls[1].name).toBe("fin_fund_rebalance");
  });
});

describe("L4 LLM Chain — Fund Response Formatting", () => {
  it("fund status response contains expected fields", () => {
    const executor = createFundToolExecutor();
    const result = JSON.parse(executor.execute("fin_fund_status", {}).content[0].text);

    expect(result).toHaveProperty("totalCapital");
    expect(result).toHaveProperty("totalEquity");
    expect(result).toHaveProperty("allocations");
    expect(result).toHaveProperty("byLevel");
    expect(result).toHaveProperty("risk");
    expect(result.byLevel).toHaveProperty("L0_INCUBATE");
    expect(result.byLevel).toHaveProperty("L1_BACKTEST");
    expect(result.byLevel).toHaveProperty("L2_PAPER");
    expect(result.byLevel).toHaveProperty("L3_LIVE");
  });

  it("rebalance response contains allocations, leaderboard, and risk", () => {
    const executor = createFundToolExecutor();
    const result = JSON.parse(executor.execute("fin_fund_rebalance", {}).content[0].text);

    expect(result).toHaveProperty("allocations");
    expect(result).toHaveProperty("leaderboard");
    expect(result).toHaveProperty("risk");
    expect(result).toHaveProperty("promotions");
    expect(result).toHaveProperty("demotions");
    expect(Array.isArray(result.allocations)).toBe(true);
    expect(Array.isArray(result.leaderboard)).toBe(true);
  });

  it("risk response includes action recommendations", () => {
    const executor = createFundToolExecutor();
    const result = JSON.parse(executor.execute("fin_fund_risk", {}).content[0].text);

    expect(result).toHaveProperty("riskLevel");
    expect(result).toHaveProperty("actions");
    expect(Array.isArray(result.actions)).toBe(true);
    expect(result.actions.length).toBeGreaterThan(0);
  });
});
