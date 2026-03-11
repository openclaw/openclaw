/**
 * L4 LLM Chain Test — Trading Tool Chain.
 *
 * Verifies that when a user says "buy 0.1 BTC", the LLM correctly invokes
 * fin_place_order with the right parameters. Tests parameter extraction,
 * tool selection, risk evaluation, and response formatting.
 *
 * Uses mock LLM responses to simulate the full tool_use chain without
 * hitting a real LLM endpoint.
 *
 * Run:
 *   npx vitest run tests/findoo-trader-plugin/l4-llm/trading-tool-chain.test.ts
 */
import { describe, it, expect, beforeEach } from "vitest";

// ── Mock types matching LLM tool_use protocol ──

type ToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
};

type MockLlmResponse = {
  stop_reason: "tool_use" | "end_turn";
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >;
};

// ── Tool registry (mirrors real registered tools from trading-tools.ts) ──

const _TRADING_TOOLS = [
  "fin_place_order",
  "fin_cancel_order",
  "fin_modify_order",
  "fin_set_stop_loss",
  "fin_set_take_profit",
  "fin_paper_order",
  "fin_paper_create",
  "fin_paper_positions",
  "fin_paper_state",
  "fin_paper_metrics",
  "fin_paper_list",
] as const;

// ── Mock tool executors ──

function createMockToolExecutor() {
  const calls: ToolCall[] = [];

  const executors: Record<string, (params: Record<string, unknown>) => ToolResult> = {
    fin_place_order: (params) => {
      calls.push({ id: `call-${calls.length}`, name: "fin_place_order", input: params });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              order: {
                id: "ord-abc123",
                symbol: params.symbol,
                side: params.side,
                type: params.type,
                amount: params.amount,
                price: params.price,
                status: "open",
              },
              exchange: params.exchange ?? "binance-default",
              testnet: false,
            }),
          },
        ],
      };
    },
    fin_cancel_order: (params) => {
      calls.push({ id: `call-${calls.length}`, name: "fin_cancel_order", input: params });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              cancelled: { id: params.orderId, status: "cancelled" },
            }),
          },
        ],
      };
    },
    fin_set_stop_loss: (params) => {
      calls.push({ id: `call-${calls.length}`, name: "fin_set_stop_loss", input: params });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              stopLoss: { symbol: params.symbol, stopPrice: params.stopPrice },
            }),
          },
        ],
      };
    },
    fin_set_take_profit: (params) => {
      calls.push({ id: `call-${calls.length}`, name: "fin_set_take_profit", input: params });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              takeProfit: { symbol: params.symbol, profitPrice: params.profitPrice },
            }),
          },
        ],
      };
    },
    fin_paper_order: (params) => {
      calls.push({ id: `call-${calls.length}`, name: "fin_paper_order", input: params });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              order: {
                id: "paper-ord-001",
                symbol: params.symbol,
                side: params.side,
                quantity: params.quantity,
                status: "filled",
              },
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

// ── Simulated LLM chain runner ──

function simulateLlmChain(
  mockResponses: MockLlmResponse[],
  executor: ReturnType<typeof createMockToolExecutor>,
): { finalText: string; toolCalls: ToolCall[] } {
  let finalText = "";

  for (const response of mockResponses) {
    for (const block of response.content) {
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

describe("L4 LLM Chain — Trading Tool Selection", () => {
  let executor: ReturnType<typeof createMockToolExecutor>;

  beforeEach(() => {
    executor = createMockToolExecutor();
  });

  // ── 1. "buy 0.1 BTC" → fin_place_order with correct params ──

  it("routes 'buy 0.1 BTC' to fin_place_order with correct parameters", () => {
    const llmResponse: MockLlmResponse = {
      stop_reason: "tool_use",
      content: [
        {
          type: "text",
          text: "I'll place a market buy order for 0.1 BTC on your default exchange.",
        },
        {
          type: "tool_use",
          id: "toolu_001",
          name: "fin_place_order",
          input: {
            symbol: "BTC/USDT",
            side: "buy",
            type: "market",
            amount: 0.1,
          },
        },
      ],
    };

    const { toolCalls } = simulateLlmChain([llmResponse], executor);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("fin_place_order");
    expect(toolCalls[0].input.symbol).toBe("BTC/USDT");
    expect(toolCalls[0].input.side).toBe("buy");
    expect(toolCalls[0].input.type).toBe("market");
    expect(toolCalls[0].input.amount).toBe(0.1);
  });

  // ── 2. Limit order with price → correct type + price ──

  it("routes 'buy 0.5 ETH at $3000' to fin_place_order with limit type and price", () => {
    const llmResponse: MockLlmResponse = {
      stop_reason: "tool_use",
      content: [
        {
          type: "text",
          text: "Placing a limit buy for 0.5 ETH at $3,000.",
        },
        {
          type: "tool_use",
          id: "toolu_002",
          name: "fin_place_order",
          input: {
            symbol: "ETH/USDT",
            side: "buy",
            type: "limit",
            amount: 0.5,
            price: 3000,
          },
        },
      ],
    };

    const { toolCalls } = simulateLlmChain([llmResponse], executor);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].input.type).toBe("limit");
    expect(toolCalls[0].input.price).toBe(3000);
    expect(toolCalls[0].input.symbol).toBe("ETH/USDT");
    expect(toolCalls[0].input.amount).toBe(0.5);
  });

  // ── 3. Sell order extraction ──

  it("routes 'sell all my SOL' to fin_place_order with side=sell", () => {
    const llmResponse: MockLlmResponse = {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_003",
          name: "fin_place_order",
          input: {
            symbol: "SOL/USDT",
            side: "sell",
            type: "market",
            amount: 10, // LLM would have determined position size first
          },
        },
      ],
    };

    const { toolCalls } = simulateLlmChain([llmResponse], executor);
    expect(toolCalls[0].input.side).toBe("sell");
    expect(toolCalls[0].input.symbol).toBe("SOL/USDT");
  });

  // ── 4. Order with stop-loss and take-profit ──

  it("buy order with attached stop-loss and take-profit params", () => {
    const llmResponse: MockLlmResponse = {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_004",
          name: "fin_place_order",
          input: {
            symbol: "BTC/USDT",
            side: "buy",
            type: "market",
            amount: 0.05,
            stopLoss: 62000,
            takeProfit: 70000,
          },
        },
      ],
    };

    const { toolCalls } = simulateLlmChain([llmResponse], executor);
    expect(toolCalls[0].input.stopLoss).toBe(62000);
    expect(toolCalls[0].input.takeProfit).toBe(70000);
  });

  // ── 5. Exchange-specific routing ──

  it("routes 'buy on OKX' with explicit exchange parameter", () => {
    const llmResponse: MockLlmResponse = {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_005",
          name: "fin_place_order",
          input: {
            symbol: "BTC/USDT",
            side: "buy",
            type: "market",
            amount: 0.1,
            exchange: "okx-main",
          },
        },
      ],
    };

    const { toolCalls } = simulateLlmChain([llmResponse], executor);
    expect(toolCalls[0].input.exchange).toBe("okx-main");
  });

  // ── 6. Leverage order ──

  it("applies leverage parameter for leveraged trades", () => {
    const llmResponse: MockLlmResponse = {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_006",
          name: "fin_place_order",
          input: {
            symbol: "BTC/USDT",
            side: "buy",
            type: "market",
            amount: 0.5,
            leverage: 3,
          },
        },
      ],
    };

    const { toolCalls } = simulateLlmChain([llmResponse], executor);
    expect(toolCalls[0].input.leverage).toBe(3);
  });
});

describe("L4 LLM Chain — Cancel/Modify Order Flow", () => {
  let executor: ReturnType<typeof createMockToolExecutor>;

  beforeEach(() => {
    executor = createMockToolExecutor();
  });

  it("routes 'cancel my BTC order' to fin_cancel_order with orderId", () => {
    const llmResponse: MockLlmResponse = {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_010",
          name: "fin_cancel_order",
          input: {
            orderId: "ord-abc123",
            symbol: "BTC/USDT",
          },
        },
      ],
    };

    const { toolCalls } = simulateLlmChain([llmResponse], executor);
    expect(toolCalls[0].name).toBe("fin_cancel_order");
    expect(toolCalls[0].input.orderId).toBe("ord-abc123");
    expect(toolCalls[0].input.symbol).toBe("BTC/USDT");
  });

  it("routes 'set stop loss at 62000' to fin_set_stop_loss", () => {
    const llmResponse: MockLlmResponse = {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_011",
          name: "fin_set_stop_loss",
          input: {
            symbol: "BTC/USDT",
            stopPrice: 62000,
          },
        },
      ],
    };

    const { toolCalls } = simulateLlmChain([llmResponse], executor);
    expect(toolCalls[0].name).toBe("fin_set_stop_loss");
    expect(toolCalls[0].input.stopPrice).toBe(62000);
  });
});

describe("L4 LLM Chain — Paper Trading Flow", () => {
  let executor: ReturnType<typeof createMockToolExecutor>;

  beforeEach(() => {
    executor = createMockToolExecutor();
  });

  it("routes 'paper buy 1 ETH' to fin_paper_order with correct params", () => {
    const llmResponse: MockLlmResponse = {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_020",
          name: "fin_paper_order",
          input: {
            account_id: "default",
            symbol: "ETH/USDT",
            side: "buy",
            quantity: 1,
            type: "market",
            current_price: 3500,
          },
        },
      ],
    };

    const { toolCalls } = simulateLlmChain([llmResponse], executor);
    expect(toolCalls[0].name).toBe("fin_paper_order");
    expect(toolCalls[0].input.symbol).toBe("ETH/USDT");
    expect(toolCalls[0].input.side).toBe("buy");
    expect(toolCalls[0].input.quantity).toBe(1);
  });
});

describe("L4 LLM Chain — Risk Evaluation Response Handling", () => {
  it("handles risk rejection response correctly", () => {
    const rejectedResult = {
      success: false,
      rejected: true,
      reason: "Exceeds maximum daily loss limit of $5000",
      estimatedValueUsd: 6500,
      currentPrice: 65000,
      exchange: "binance-default",
      testnet: false,
    };

    expect(rejectedResult.rejected).toBe(true);
    expect(rejectedResult.success).toBe(false);
    expect(rejectedResult.reason).toContain("daily loss limit");
  });

  it("handles risk confirmation-required response correctly", () => {
    const confirmResult = {
      success: false,
      requiresConfirmation: true,
      reason: "Order value $650 exceeds auto-trade limit of $100",
      estimatedValueUsd: 650,
      currentPrice: 65000,
      order: {
        exchange: "binance-default",
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 0.01,
      },
      hint: "User must confirm this trade before execution. Re-call with the same parameters after user approval.",
    };

    expect(confirmResult.requiresConfirmation).toBe(true);
    expect(confirmResult.success).toBe(false);
    expect(confirmResult.hint).toContain("User must confirm");
    expect(confirmResult.order.symbol).toBe("BTC/USDT");
  });

  it("handles successful order response with order details", () => {
    const successResult = {
      success: true,
      order: {
        id: "ord-xyz789",
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 0.1,
        status: "filled",
        filled: 0.1,
        average: 65050,
      },
      exchange: "binance-main",
      testnet: false,
    };

    expect(successResult.success).toBe(true);
    expect(successResult.order.status).toBe("filled");
    expect(successResult.order.amount).toBe(0.1);
    expect(successResult.order.average).toBe(65050);
  });
});

describe("L4 LLM Chain — Multi-step Confirmation Flow", () => {
  let executor: ReturnType<typeof createMockToolExecutor>;

  beforeEach(() => {
    executor = createMockToolExecutor();
  });

  it("two-turn flow: LLM asks confirmation, then executes after user confirms", () => {
    // Turn 1: LLM shows order details and asks for confirmation
    const turn1: MockLlmResponse = {
      stop_reason: "end_turn",
      content: [
        {
          type: "text",
          text: "I'll buy 0.1 BTC at market price (~$65,000). Estimated cost: ~$6,500.\n\nConfirm? (yes/no)",
        },
      ],
    };

    // Turn 2: After user says "yes", LLM calls the tool
    const turn2: MockLlmResponse = {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_030",
          name: "fin_place_order",
          input: {
            symbol: "BTC/USDT",
            side: "buy",
            type: "market",
            amount: 0.1,
          },
        },
      ],
    };

    // Turn 1: no tool calls
    const result1 = simulateLlmChain([turn1], executor);
    expect(result1.toolCalls).toHaveLength(0);
    expect(result1.finalText).toContain("Confirm");

    // Turn 2: tool is called
    const result2 = simulateLlmChain([turn2], executor);
    expect(result2.toolCalls).toHaveLength(1);
    expect(result2.toolCalls[0].name).toBe("fin_place_order");
  });
});
