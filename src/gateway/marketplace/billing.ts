/**
 * Marketplace billing — pricing calculation and transaction reporting.
 *
 * Pricing model:
 * - Buyer pays a fraction of Anthropic's list price (default: 60%)
 * - Platform takes a percentage (default: 20%)
 * - Seller receives the remainder
 * - $AI token payouts get a bonus (default: 10%)
 */
import type { MarketplaceConfig } from "../../config/types.gateway.js";

/** Per-model pricing in USD per million tokens [input, output]. */
const MODEL_PRICING: Record<string, [number, number]> = {
  // Claude 4 family
  "claude-opus-4-20250514": [15, 75],
  "claude-sonnet-4-20250514": [3, 15],
  "claude-haiku-3-5-20241022": [0.8, 4],
  // Claude 3.5 family
  "claude-3-5-sonnet-20241022": [3, 15],
  "claude-3-5-haiku-20241022": [0.8, 4],
  // Claude 3 family
  "claude-3-opus-20240229": [15, 75],
  "claude-3-sonnet-20240229": [3, 15],
  "claude-3-haiku-20240307": [0.25, 1.25],
};

/** Fallback pricing when model is not in the table. */
const FALLBACK_PRICING: [number, number] = [3, 15];

export type MarketplacePricing = {
  /** Amount charged to the buyer (cents). */
  buyerCostCents: number;
  /** Amount credited to the seller (cents). */
  sellerEarningsCents: number;
  /** Amount retained by the platform (cents). */
  platformFeeCents: number;
};

export type MarketplaceTransaction = {
  requestId: string;
  buyerUserId: string;
  buyerOrgId: string;
  sellerNodeId: string;
  sellerUserId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  buyerCostCents: number;
  sellerEarningsCents: number;
  platformFeeCents: number;
  aiTokenPayout: boolean;
  timestamp: number;
  durationMs: number;
};

/**
 * Calculate marketplace pricing for a completed request.
 */
export function calculateMarketplacePrice(params: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  config: MarketplaceConfig;
}): MarketplacePricing {
  const { model, inputTokens, outputTokens, config } = params;

  const [inputPricePerM, outputPricePerM] = MODEL_PRICING[model] ?? FALLBACK_PRICING;
  const priceFraction = config.priceFraction ?? 0.6;
  const platformFeePct = config.platformFeePct ?? 20;

  // Calculate list price in cents.
  const listInputCents = (inputTokens / 1_000_000) * inputPricePerM * 100;
  const listOutputCents = (outputTokens / 1_000_000) * outputPricePerM * 100;
  const listTotalCents = listInputCents + listOutputCents;

  // Buyer pays a fraction of list price.
  const buyerCostCents = Math.max(1, Math.round(listTotalCents * priceFraction));

  // Platform takes its cut from what the buyer pays.
  const platformFeeCents = Math.max(0, Math.round(buyerCostCents * (platformFeePct / 100)));

  // Seller gets the rest.
  const sellerEarningsCents = Math.max(0, buyerCostCents - platformFeeCents);

  return { buyerCostCents, sellerEarningsCents, platformFeeCents };
}

/**
 * Calculate seller earnings with optional $AI token bonus.
 */
export function calculateSellerPayout(
  earningsCents: number,
  preference: "usd" | "ai_token",
  aiTokenBonusPct: number,
): { amountCents: number; bonusCents: number; total: number } {
  if (preference === "ai_token") {
    const bonusCents = Math.round(earningsCents * (aiTokenBonusPct / 100));
    return {
      amountCents: earningsCents,
      bonusCents,
      total: earningsCents + bonusCents,
    };
  }
  return { amountCents: earningsCents, bonusCents: 0, total: earningsCents };
}

/**
 * Build Commerce API usage report payload for a marketplace transaction.
 * Returns three entries: buyer debit, seller credit, platform revenue.
 */
export function buildCommercePayloads(tx: MarketplaceTransaction): Array<{
  user: string;
  currency: string;
  amount: number;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  nodeId?: string;
  metadata?: Record<string, string>;
}> {
  const base = {
    currency: "usd",
    model: tx.model,
    provider: "marketplace",
    promptTokens: tx.inputTokens,
    completionTokens: tx.outputTokens,
    totalTokens: tx.inputTokens + tx.outputTokens,
  };

  return [
    // 1. Buyer debit
    {
      ...base,
      user: `${tx.buyerOrgId}/${tx.buyerUserId}`,
      amount: tx.buyerCostCents,
      metadata: { type: "marketplace_buyer", sellerNode: tx.sellerNodeId },
    },
    // 2. Seller credit (negative amount = credit)
    {
      ...base,
      user: tx.sellerUserId,
      amount: -tx.sellerEarningsCents,
      nodeId: tx.sellerNodeId,
      metadata: { type: "marketplace_seller", requestId: tx.requestId },
    },
    // 3. Platform revenue
    {
      ...base,
      user: "platform/marketplace",
      amount: tx.platformFeeCents,
      metadata: { type: "marketplace_platform", requestId: tx.requestId },
    },
  ];
}
