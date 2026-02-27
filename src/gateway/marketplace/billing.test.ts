import { describe, it, expect } from "vitest";
import type { MarketplaceConfig } from "../../config/types.gateway.js";
import {
  calculateMarketplacePrice,
  calculateSellerPayout,
  buildCommercePayloads,
  type MarketplaceTransaction,
} from "./billing.js";

const defaultConfig: MarketplaceConfig = {
  priceFraction: 0.6,
  platformFeePct: 20,
  aiTokenBonusPct: 10,
  minPayoutCents: 1000,
};

describe("calculateMarketplacePrice", () => {
  it("calculates pricing for a known model (sonnet 4)", () => {
    const result = calculateMarketplacePrice({
      model: "claude-sonnet-4-20250514",
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      config: defaultConfig,
    });

    // Sonnet 4: $3/$15 per MTok
    // Input: 1M tokens * $3/MTok = $3.00 = 300 cents
    // Output: 100K tokens * $15/MTok = $1.50 = 150 cents
    // List total: 450 cents
    // Buyer pays 60%: 270 cents
    // Platform 20% of buyer cost: 54 cents
    // Seller gets rest: 216 cents
    expect(result.buyerCostCents).toBe(270);
    expect(result.platformFeeCents).toBe(54);
    expect(result.sellerEarningsCents).toBe(216);
  });

  it("calculates pricing for opus (expensive model)", () => {
    const result = calculateMarketplacePrice({
      model: "claude-opus-4-20250514",
      inputTokens: 500_000,
      outputTokens: 50_000,
      config: defaultConfig,
    });

    // Opus: $15/$75 per MTok
    // Input: 0.5M * $15 = $7.50 = 750 cents
    // Output: 0.05M * $75 = $3.75 = 375 cents
    // List total: 1125 cents
    // Buyer pays 60%: 675 cents
    // Platform 20%: 135 cents
    // Seller: 540 cents
    expect(result.buyerCostCents).toBe(675);
    expect(result.platformFeeCents).toBe(135);
    expect(result.sellerEarningsCents).toBe(540);
  });

  it("uses fallback pricing for unknown models", () => {
    const result = calculateMarketplacePrice({
      model: "claude-unknown-model",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      config: defaultConfig,
    });

    // Fallback: $3/$15 per MTok (same as sonnet)
    // Input: 1M * $3 = 300 cents
    // Output: 1M * $15 = 1500 cents
    // List: 1800 cents
    // Buyer 60%: 1080
    // Platform 20%: 216
    // Seller: 864
    expect(result.buyerCostCents).toBe(1080);
    expect(result.platformFeeCents).toBe(216);
    expect(result.sellerEarningsCents).toBe(864);
  });

  it("enforces minimum buyer cost of 1 cent", () => {
    const result = calculateMarketplacePrice({
      model: "claude-haiku-3-5-20241022",
      inputTokens: 1,
      outputTokens: 1,
      config: defaultConfig,
    });

    // Tiny token counts → would round to 0, but minimum is 1
    expect(result.buyerCostCents).toBe(1);
  });

  it("respects custom priceFraction", () => {
    const customConfig: MarketplaceConfig = {
      ...defaultConfig,
      priceFraction: 0.8,
    };
    const resultDefault = calculateMarketplacePrice({
      model: "claude-sonnet-4-20250514",
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      config: defaultConfig,
    });
    const resultCustom = calculateMarketplacePrice({
      model: "claude-sonnet-4-20250514",
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      config: customConfig,
    });

    expect(resultCustom.buyerCostCents).toBeGreaterThan(resultDefault.buyerCostCents);
  });

  it("ensures buyer cost = platform fee + seller earnings", () => {
    const result = calculateMarketplacePrice({
      model: "claude-sonnet-4-20250514",
      inputTokens: 1_234_567,
      outputTokens: 567_890,
      config: defaultConfig,
    });

    expect(result.buyerCostCents).toBe(result.platformFeeCents + result.sellerEarningsCents);
  });
});

describe("calculateSellerPayout", () => {
  it("returns USD payout with no bonus", () => {
    const result = calculateSellerPayout(1000, "usd", 10);
    expect(result.amountCents).toBe(1000);
    expect(result.bonusCents).toBe(0);
    expect(result.total).toBe(1000);
  });

  it("returns AI token payout with bonus", () => {
    const result = calculateSellerPayout(1000, "ai_token", 10);
    expect(result.amountCents).toBe(1000);
    expect(result.bonusCents).toBe(100);
    expect(result.total).toBe(1100);
  });

  it("handles zero earnings", () => {
    const result = calculateSellerPayout(0, "ai_token", 10);
    expect(result.total).toBe(0);
  });
});

describe("buildCommercePayloads", () => {
  const tx: MarketplaceTransaction = {
    requestId: "req-123",
    buyerUserId: "buyer-1",
    buyerOrgId: "org-1",
    sellerNodeId: "seller-node-1",
    sellerUserId: "seller-1",
    model: "claude-sonnet-4-20250514",
    inputTokens: 500_000,
    outputTokens: 50_000,
    buyerCostCents: 135,
    sellerEarningsCents: 108,
    platformFeeCents: 27,
    aiTokenPayout: false,
    timestamp: Date.now(),
    durationMs: 5000,
  };

  it("returns three entries: buyer debit, seller credit, platform revenue", () => {
    const payloads = buildCommercePayloads(tx);
    expect(payloads).toHaveLength(3);
  });

  it("buyer entry has positive amount (debit)", () => {
    const payloads = buildCommercePayloads(tx);
    const buyer = payloads[0];
    expect(buyer.amount).toBe(135);
    expect(buyer.user).toBe("org-1/buyer-1");
    expect(buyer.metadata?.type).toBe("marketplace_buyer");
  });

  it("seller entry has negative amount (credit)", () => {
    const payloads = buildCommercePayloads(tx);
    const seller = payloads[1];
    expect(seller.amount).toBe(-108);
    expect(seller.user).toBe("seller-1");
    expect(seller.nodeId).toBe("seller-node-1");
    expect(seller.metadata?.type).toBe("marketplace_seller");
  });

  it("platform entry has positive amount (revenue)", () => {
    const payloads = buildCommercePayloads(tx);
    const platform = payloads[2];
    expect(platform.amount).toBe(27);
    expect(platform.user).toBe("platform/marketplace");
    expect(platform.metadata?.type).toBe("marketplace_platform");
  });

  it("all entries share common fields", () => {
    const payloads = buildCommercePayloads(tx);
    for (const p of payloads) {
      expect(p.currency).toBe("usd");
      expect(p.model).toBe("claude-sonnet-4-20250514");
      expect(p.provider).toBe("marketplace");
      expect(p.promptTokens).toBe(500_000);
      expect(p.completionTokens).toBe(50_000);
      expect(p.totalTokens).toBe(550_000);
    }
  });
});
