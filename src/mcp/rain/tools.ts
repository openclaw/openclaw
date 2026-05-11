/**
 * MCP tool definitions for the Rain skill (V1.5).
 *
 * Read + build only:
 *   rain_list_markets, rain_get_market, rain_build_buy, rain_build_claim
 *
 * No composite execute tools in V1.5 (see openclaw-dashboard
 * RAIN_V2_ARCHITECTURE.md §14.6). Typed MCP tools prevent URL hallucination
 * but do not enforce user confirmation. Execution stays via wallet
 * runtime's sign-tx with explicit per-transaction user approval.
 *
 * As V2 Phase A endpoints ship in the dashboard, one new tool stub gets
 * added here per endpoint.
 */

import type { RainRuntimeClient } from "./runtime-client.js";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (client: RainRuntimeClient, args: Record<string, unknown>) => Promise<unknown>;
}

const MARKET_STATUSES = [
  "Live",
  "New",
  "WaitingForResult",
  "UnderDispute",
  "UnderAppeal",
  "ClosingSoon",
  "InReview",
  "InEvaluation",
  "Closed",
  "Trading",
] as const;

const SORT_BY = ["Liquidity", "Volumn", "latest"] as const;

/** Coerce an `unknown` argument value to a string, rejecting non-string types. */
function asString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return value.toString();
  }
  throw new Error(`expected string argument, got ${typeof value}`);
}

/** Coerce an `unknown` argument value to a number, rejecting non-numeric types. */
function asNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new Error(`expected number argument, got ${typeof value}`);
}

/** Optional string — returns undefined if the value is missing or not a string. */
function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Optional number — returns undefined if missing, else coerced. */
function asOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return asNumber(value);
}

export const RAIN_TOOLS: ToolDef[] = [
  {
    name: "rain_list_markets",
    description:
      "List public Rain prediction markets on Arbitrum. Returns id, title, totalVolume, status, and contractAddress for each.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 0, maximum: 50, default: 20 },
        offset: { type: "integer", minimum: 0, maximum: 10000, default: 0 },
        status: {
          type: "string",
          enum: MARKET_STATUSES,
          description: "Filter by market status.",
        },
        sortBy: {
          type: "string",
          enum: SORT_BY,
          description: 'Sort key. Note "Volumn" is the SDK spelling — intentional, do not correct.',
        },
        creator: {
          type: "string",
          description: "Filter by creator address (no validation).",
        },
      },
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.listMarkets({
        limit: asOptionalNumber(args.limit),
        offset: asOptionalNumber(args.offset),
        status: asOptionalString(args.status),
        sortBy: asOptionalString(args.sortBy),
        creator: asOptionalString(args.creator),
      }),
  },
  {
    name: "rain_get_market",
    description:
      "Get full detail for one Rain market: metadata, options, current prices, liquidity, baseToken, baseTokenDecimals. Use details.contractAddress for rain_build_buy; use details.baseTokenDecimals to compute buyAmountInWei.",
    inputSchema: {
      type: "object",
      properties: {
        marketId: {
          type: "string",
          minLength: 1,
          description: "Rain market id (from rain_list_markets).",
        },
      },
      required: ["marketId"],
      additionalProperties: false,
    },
    handler: (client, args) => client.getMarket(asString(args.marketId)),
  },
  {
    name: "rain_build_buy",
    description:
      "Build a buy-option transaction preview. Returns rawTx + walletRequest for the user-approved wallet sign-tx call. " +
      "Pass ownerAddress (the agent wallet address) to get a deterministic prerequisiteTxs[] list: if the base-token allowance is insufficient an erc20_approve walletRequest is included that must be executed before the buy. " +
      "Without ownerAddress, approvalMayBeRequired: true is returned and the agent must check allowance separately.",
    inputSchema: {
      type: "object",
      properties: {
        marketContractAddress: {
          type: "string",
          pattern: "^0x[a-fA-F0-9]{40}$",
          description: "Market contract address (from rain_get_market details.contractAddress).",
        },
        selectedOption: {
          type: "integer",
          minimum: 0,
          description: "Zero-based option index.",
        },
        buyAmountInWei: {
          type: "string",
          pattern: "^[1-9][0-9]*$",
          description:
            "Buy amount in the market's base token's smallest unit, as a string-encoded integer > 0. Read details.baseTokenDecimals from rain_get_market first — markets are not all USDT.",
        },
        ownerAddress: {
          type: "string",
          pattern: "^0x[a-fA-F0-9]{40}$",
          description:
            "Agent wallet address. When provided, the server checks ERC-20 allowance and populates prerequisiteTxs[] with an erc20_approve entry if approval is needed.",
        },
      },
      required: ["marketContractAddress", "selectedOption", "buyAmountInWei"],
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.buildBuy({
        marketContractAddress: asString(args.marketContractAddress),
        selectedOption: asNumber(args.selectedOption),
        buyAmountInWei: asString(args.buyAmountInWei),
        ownerAddress: args.ownerAddress != null ? asString(args.ownerAddress) : undefined,
      }),
  },
  {
    name: "rain_build_sell",
    description:
      "Build a sell-option (limit-order) transaction preview. Returns rawTx + walletRequest for the user-approved wallet sign-tx call. No ERC-20 approval prerequisite needed for sells.",
    inputSchema: {
      type: "object",
      properties: {
        marketContractAddress: {
          type: "string",
          pattern: "^0x[a-fA-F0-9]{40}$",
          description: "Market contract address (from rain_get_market details.contractAddress).",
        },
        selectedOption: {
          type: "integer",
          minimum: 0,
          description: "Zero-based option index of the shares being sold.",
        },
        sharesAmountWei: {
          type: "string",
          pattern: "^[1-9][0-9]*$",
          description:
            "Number of shares to sell in the token's smallest unit, as a string-encoded integer > 0. Use details.baseTokenDecimals from rain_get_market to compute.",
        },
        pricePerShare: {
          type: "string",
          description:
            "Limit price per share as a string-encoded decimal between 0 and 1 (e.g. '0.55'). Must be within the range of current market prices.",
        },
        tokenDecimals: {
          type: "integer",
          minimum: 0,
          maximum: 18,
          description:
            "Optional. Base-token decimals. Defaults to market's baseTokenDecimals when omitted.",
        },
      },
      required: ["marketContractAddress", "selectedOption", "sharesAmountWei", "pricePerShare"],
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.buildSell({
        marketContractAddress: asString(args.marketContractAddress),
        selectedOption: asNumber(args.selectedOption),
        sharesAmountWei: asString(args.sharesAmountWei),
        pricePerShare: asString(args.pricePerShare),
        tokenDecimals: args.tokenDecimals != null ? asNumber(args.tokenDecimals) : undefined,
      }),
  },
  {
    name: "rain_build_add_liquidity",
    description:
      "Build an add-liquidity transaction preview. Deposits base tokens into a market pool in exchange for LP shares. " +
      "Pass ownerAddress to get a deterministic prerequisiteTxs[] list (same approval pattern as rain_build_buy). " +
      "Returns rawTx + walletRequest.",
    inputSchema: {
      type: "object",
      properties: {
        marketContractAddress: {
          type: "string",
          pattern: "^0x[a-fA-F0-9]{40}$",
          description: "Market contract address (from rain_get_market details.contractAddress).",
        },
        liquidityAmountInWei: {
          type: "string",
          pattern: "^[1-9][0-9]*$",
          description:
            "Amount of base tokens to deposit, in the token's smallest unit. Use details.baseTokenDecimals from rain_get_market to compute.",
        },
        ownerAddress: {
          type: "string",
          pattern: "^0x[a-fA-F0-9]{40}$",
          description:
            "Agent wallet address. When provided, the server checks ERC-20 allowance and returns an erc20_approve prerequisiteTx if needed.",
        },
      },
      required: ["marketContractAddress", "liquidityAmountInWei"],
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.buildAddLiquidity({
        marketContractAddress: asString(args.marketContractAddress),
        liquidityAmountInWei: asString(args.liquidityAmountInWei),
        ownerAddress: args.ownerAddress != null ? asString(args.ownerAddress) : undefined,
      }),
  },
  {
    name: "rain_get_price_history",
    description:
      "Fetch OHLCV candle data for one option of a Rain market. Useful for charting price movement or informing limit-sell price selection.",
    inputSchema: {
      type: "object",
      properties: {
        marketId: { type: "string", minLength: 1, description: "Rain market id." },
        optionIndex: { type: "integer", minimum: 0, description: "Zero-based option index." },
        interval: {
          type: "string",
          enum: ["1m", "5m", "15m", "1h", "4h", "1d", "1w"],
          description: "Candle interval.",
        },
        from: {
          type: "string",
          description: "Start of range as a string-encoded unix timestamp in seconds (optional).",
        },
        to: {
          type: "string",
          description: "End of range as a string-encoded unix timestamp in seconds (optional).",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Max candles to return (default: server default, max 500).",
        },
      },
      required: ["marketId", "optionIndex", "interval"],
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.getPriceHistory({
        marketId: asString(args.marketId),
        optionIndex: asNumber(args.optionIndex),
        interval: asString(args.interval),
        from: args.from != null ? asString(args.from) : undefined,
        to: args.to != null ? asString(args.to) : undefined,
        limit: args.limit != null ? asNumber(args.limit) : undefined,
      }),
  },
  {
    name: "rain_build_claim",
    description:
      "Build a claim transaction preview. Returns rawTx + walletRequest for the user-approved wallet sign-tx call. No approval prerequisite needed for claims.",
    inputSchema: {
      type: "object",
      properties: {
        marketId: {
          type: "string",
          minLength: 1,
          description: "Rain market id.",
        },
        walletAddress: {
          type: "string",
          pattern: "^0x[a-fA-F0-9]{40}$",
          description: "Wallet address to claim to.",
        },
      },
      required: ["marketId", "walletAddress"],
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.buildClaim({
        marketId: asString(args.marketId),
        walletAddress: asString(args.walletAddress),
      }),
  },

  // ── V2 Phase A — Slice A.0 helpers + diagnostics ───────────────────────────

  {
    name: "rain_get_market_address",
    description:
      "Resolve a Rain marketId to its on-chain contract address. Use when a V2 endpoint requires marketAddress but you only have marketId.",
    inputSchema: {
      type: "object",
      properties: {
        marketId: { type: "string", minLength: 1, description: "Rain market id." },
      },
      required: ["marketId"],
      additionalProperties: false,
    },
    handler: (client, args) => client.getMarketAddress(asString(args.marketId)),
  },
  {
    name: "rain_resolve_market_id",
    description:
      "Resolve a Rain on-chain contract address to its marketId. Reverse of rain_get_market_address.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          pattern: "^0x[a-fA-F0-9]{40}$",
          description: "Market contract address (0x-prefixed).",
        },
      },
      required: ["address"],
      additionalProperties: false,
    },
    handler: (client, args) => client.resolveMarketId(asString(args.address)),
  },
  {
    name: "rain_get_config",
    description:
      "Return the Rain runtime's active configuration: chain, environment, and whether secrets are configured. Never returns secret values.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: (client) => client.getConfig(),
  },
  {
    name: "rain_get_health",
    description:
      "Composite Rain runtime health check. Returns ok:true only if both RPC and subgraph are reachable. Use to diagnose connectivity issues.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: (client) => client.getHealth(),
  },
  {
    name: "rain_get_transaction_details",
    description:
      "Get details for a specific Rain transaction by hash: block number, timestamp, status, gas used, and on-chain events.",
    inputSchema: {
      type: "object",
      properties: {
        txHash: {
          type: "string",
          pattern: "^0x[a-fA-F0-9]{64}$",
          description: "Transaction hash (0x-prefixed, 32 bytes).",
        },
      },
      required: ["txHash"],
      additionalProperties: false,
    },
    handler: (client, args) => client.getTransactionDetails(asString(args.txHash)),
  },

  // ── V2 Phase A — Slice 3: positions / portfolio / PnL ─────────────────────

  {
    name: "rain_get_positions",
    description:
      "Get all Rain market positions for a wallet. Returns markets the wallet has participated in with option shares, LP liquidity, claim status.",
    inputSchema: {
      type: "object",
      properties: {
        walletAddress: {
          type: "string",
          pattern: "^0x[a-fA-F0-9]{40}$",
          description: "Wallet address.",
        },
      },
      required: ["walletAddress"],
      additionalProperties: false,
    },
    handler: (client, args) => client.getPositions(asString(args.walletAddress)),
  },
  {
    name: "rain_get_position_by_market",
    description:
      "Get a wallet's position in a specific Rain market: option shares, LP liquidity, claim status.",
    inputSchema: {
      type: "object",
      properties: {
        marketId: { type: "string", minLength: 1, description: "Rain market id." },
        walletAddress: {
          type: "string",
          pattern: "^0x[a-fA-F0-9]{40}$",
          description: "Wallet address.",
        },
      },
      required: ["marketId", "walletAddress"],
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.getPositionByMarket(asString(args.marketId), asString(args.walletAddress)),
  },
  {
    name: "rain_get_lp_position",
    description: "Get a wallet's LP (liquidity provider) position in a specific Rain market.",
    inputSchema: {
      type: "object",
      properties: {
        marketId: { type: "string", minLength: 1, description: "Rain market id." },
        walletAddress: {
          type: "string",
          pattern: "^0x[a-fA-F0-9]{40}$",
          description: "Wallet address.",
        },
      },
      required: ["marketId", "walletAddress"],
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.getLpPosition(asString(args.marketId), asString(args.walletAddress)),
  },
  {
    name: "rain_get_portfolio_value",
    description:
      "Get the total portfolio value for a wallet across all Rain markets and specified token balances.",
    inputSchema: {
      type: "object",
      properties: {
        walletAddress: {
          type: "string",
          pattern: "^0x[a-fA-F0-9]{40}$",
          description: "Wallet address.",
        },
        tokenAddresses: {
          type: "array",
          items: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
          minItems: 1,
          description: "ERC-20 token addresses to include in the balance calculation.",
        },
      },
      required: ["walletAddress", "tokenAddresses"],
      additionalProperties: false,
    },
    handler: (client, args) => {
      const tokens = (args.tokenAddresses as unknown[]).map((t) => asString(t));
      return client.getPortfolioValue(asString(args.walletAddress), tokens);
    },
  },
  {
    name: "rain_get_pnl",
    description:
      "Get realized + unrealized PnL for a wallet. Optionally filter to a single market by marketAddress. Note: filter takes marketAddress (on-chain address), not marketId — use rain_get_market_address to convert if needed.",
    inputSchema: {
      type: "object",
      properties: {
        walletAddress: {
          type: "string",
          pattern: "^0x[a-fA-F0-9]{40}$",
          description: "Wallet address.",
        },
        marketAddress: {
          type: "string",
          pattern: "^0x[a-fA-F0-9]{40}$",
          description:
            "Optional. Filter PnL to a specific market by its on-chain contract address.",
        },
      },
      required: ["walletAddress"],
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.getPnl(asString(args.walletAddress), asOptionalString(args.marketAddress)),
  },

  // ── V2 Phase A — Slice 4: trade history + transactions + market activity ───

  {
    name: "rain_get_trade_history",
    description:
      "Get trade history for a wallet in a specific Rain market. Both walletAddress AND marketAddress are required.",
    inputSchema: {
      type: "object",
      properties: {
        walletAddress: {
          type: "string",
          pattern: "^0x[a-fA-F0-9]{40}$",
          description: "Wallet address.",
        },
        marketAddress: {
          type: "string",
          pattern: "^0x[a-fA-F0-9]{40}$",
          description: "Market on-chain contract address.",
        },
      },
      required: ["walletAddress", "marketAddress"],
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.getTradeHistory(asString(args.walletAddress), asString(args.marketAddress)),
  },
  {
    name: "rain_get_transactions",
    description: "Get paginated transaction history for a wallet across all Rain markets.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$", description: "Wallet address." },
        first: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Page size (default 20).",
        },
        skip: { type: "integer", minimum: 0, description: "Offset for pagination." },
        orderDirection: {
          type: "string",
          enum: ["asc", "desc"],
          description: "Sort direction (default desc).",
        },
      },
      required: ["address"],
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.getTransactions(asString(args.address), {
        first: asOptionalNumber(args.first),
        skip: asOptionalNumber(args.skip),
        orderDirection: asOptionalString(args.orderDirection),
      }),
  },
  {
    name: "rain_get_market_transactions",
    description:
      "Get all transactions for a specific Rain market by its on-chain contract address.",
    inputSchema: {
      type: "object",
      properties: {
        marketAddress: {
          type: "string",
          pattern: "^0x[a-fA-F0-9]{40}$",
          description: "Market on-chain contract address.",
        },
        first: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Page size (default 20).",
        },
      },
      required: ["marketAddress"],
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.getMarketTransactions(asString(args.marketAddress), {
        first: asOptionalNumber(args.first),
      }),
  },
];
