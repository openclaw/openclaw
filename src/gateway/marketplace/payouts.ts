/**
 * Marketplace payout processing — automated seller payouts.
 *
 * Payout channels:
 *   USD:      Commerce Stripe Connect affiliate system
 *   $AI token: Token distribution API with configurable bonus
 *
 * Payout schedule:
 *   - Minimum threshold: configurable (default $10)
 *   - Frequency: weekly (triggered by cron or manual)
 *   - Records are pulled from Commerce API earnings ledger
 */

import type { MarketplaceConfig } from "../../config/types.gateway.js";

export type PayoutRequest = {
  sellerUserId: string;
  sellerNodeId: string;
  amountCents: number;
  preference: "usd" | "ai_token";
  periodStart: number;
  periodEnd: number;
};

export type PayoutResult = {
  sellerUserId: string;
  amountCents: number;
  bonusCents: number;
  totalCents: number;
  preference: "usd" | "ai_token";
  status: "paid" | "pending" | "below_minimum" | "failed";
  error?: string;
  transactionId?: string;
};

/**
 * Process a batch of payout requests.
 *
 * For each seller:
 * 1. Verify accumulated earnings meet minimum threshold
 * 2. For USD: POST to Commerce affiliate payout endpoint
 * 3. For $AI: POST to token distribution API with bonus
 * 4. Record payout result
 */
export async function processPayouts(
  requests: PayoutRequest[],
  config: MarketplaceConfig,
): Promise<PayoutResult[]> {
  const minPayoutCents = config.minPayoutCents ?? 1000; // $10 default
  const aiTokenBonusPct = config.aiTokenBonusPct ?? 10;
  const results: PayoutResult[] = [];

  for (const req of requests) {
    if (req.amountCents < minPayoutCents) {
      results.push({
        sellerUserId: req.sellerUserId,
        amountCents: req.amountCents,
        bonusCents: 0,
        totalCents: req.amountCents,
        preference: req.preference,
        status: "below_minimum",
      });
      continue;
    }

    if (req.preference === "ai_token") {
      const result = await processAiTokenPayout(req, aiTokenBonusPct);
      results.push(result);
    } else {
      const result = await processUsdPayout(req);
      results.push(result);
    }
  }

  return results;
}

async function processUsdPayout(req: PayoutRequest): Promise<PayoutResult> {
  const baseUrl = (
    process.env.COMMERCE_API_URL ?? "http://commerce.hanzo.svc.cluster.local:8001"
  ).replace(/\/+$/, "");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (process.env.COMMERCE_SERVICE_TOKEN) {
    headers.Authorization = `Bearer ${process.env.COMMERCE_SERVICE_TOKEN}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(`${baseUrl}/api/v1/affiliates/payouts`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        userId: req.sellerUserId,
        amountCents: req.amountCents,
        currency: "usd",
        source: "marketplace",
        periodStart: new Date(req.periodStart).toISOString(),
        periodEnd: new Date(req.periodEnd).toISOString(),
        nodeId: req.sellerNodeId,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return {
        sellerUserId: req.sellerUserId,
        amountCents: req.amountCents,
        bonusCents: 0,
        totalCents: req.amountCents,
        preference: "usd",
        status: "failed",
        error: `Commerce API ${response.status}: ${errText.substring(0, 200)}`,
      };
    }

    const data = (await response.json()) as { transactionId?: string };
    return {
      sellerUserId: req.sellerUserId,
      amountCents: req.amountCents,
      bonusCents: 0,
      totalCents: req.amountCents,
      preference: "usd",
      status: "paid",
      transactionId: data.transactionId,
    };
  } catch (err) {
    return {
      sellerUserId: req.sellerUserId,
      amountCents: req.amountCents,
      bonusCents: 0,
      totalCents: req.amountCents,
      preference: "usd",
      status: "failed",
      error: `payout request failed: ${String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function processAiTokenPayout(req: PayoutRequest, bonusPct: number): Promise<PayoutResult> {
  const bonusCents = Math.round(req.amountCents * (bonusPct / 100));
  const totalCents = req.amountCents + bonusCents;

  const baseUrl = (
    process.env.COMMERCE_API_URL ?? "http://commerce.hanzo.svc.cluster.local:8001"
  ).replace(/\/+$/, "");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (process.env.COMMERCE_SERVICE_TOKEN) {
    headers.Authorization = `Bearer ${process.env.COMMERCE_SERVICE_TOKEN}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(`${baseUrl}/api/v1/tokens/distribute`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        userId: req.sellerUserId,
        amountCents: totalCents,
        currency: "ai_token",
        source: "marketplace",
        baseCents: req.amountCents,
        bonusCents,
        bonusPct,
        periodStart: new Date(req.periodStart).toISOString(),
        periodEnd: new Date(req.periodEnd).toISOString(),
        nodeId: req.sellerNodeId,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return {
        sellerUserId: req.sellerUserId,
        amountCents: req.amountCents,
        bonusCents,
        totalCents,
        preference: "ai_token",
        status: "failed",
        error: `Token API ${response.status}: ${errText.substring(0, 200)}`,
      };
    }

    const data = (await response.json()) as { transactionId?: string };
    return {
      sellerUserId: req.sellerUserId,
      amountCents: req.amountCents,
      bonusCents,
      totalCents,
      preference: "ai_token",
      status: "paid",
      transactionId: data.transactionId,
    };
  } catch (err) {
    return {
      sellerUserId: req.sellerUserId,
      amountCents: req.amountCents,
      bonusCents,
      totalCents,
      preference: "ai_token",
      status: "failed",
      error: `token payout request failed: ${String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
