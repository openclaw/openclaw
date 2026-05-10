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
      "Build a buy-option transaction preview. Returns rawTx + walletRequest for the user-approved wallet sign-tx call. approvalMayBeRequired: true means an ERC-20 approve may need to precede the buy.",
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
      },
      required: ["marketContractAddress", "selectedOption", "buyAmountInWei"],
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.buildBuy({
        marketContractAddress: asString(args.marketContractAddress),
        selectedOption: asNumber(args.selectedOption),
        buyAmountInWei: asString(args.buyAmountInWei),
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
];
