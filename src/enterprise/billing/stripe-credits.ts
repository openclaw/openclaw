/**
 * Stripe Credits Integration
 *
 * Handles credit purchases via Stripe Checkout and auto-top-up
 * via saved payment methods. Pure usage model — no subscriptions.
 */

import { getOrg } from "../tenants/tenant-store.js";
import type { OrgId } from "../tenants/types.js";
import { addCredits, autoTopUpQueue, getAutoTopUp } from "./credits.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface StripeCheckoutResult {
  checkoutUrl: string;
  sessionId: string;
}

export interface StripePortalResult {
  portalUrl: string;
}

export interface PaymentRecord {
  id: string;
  orgId: OrgId;
  amountCents: number;
  status: "pending" | "succeeded" | "failed";
  stripePaymentIntentId: string | null;
  createdAt: Date;
}

// ── Checkout Session ─────────────────────────────────────────────────────────

/**
 * Create a Stripe Checkout session for purchasing credits.
 *
 * In production:
 * ```
 * const session = await stripe.checkout.sessions.create({
 *   mode: "payment",
 *   line_items: [{
 *     price_data: {
 *       currency: "usd",
 *       unit_amount: amountCents,
 *       product_data: { name: `${amountCents / 100} OpenClaw Credits` },
 *     },
 *     quantity: 1,
 *   }],
 *   metadata: { orgId, amountCents: String(amountCents) },
 *   success_url: `${baseUrl}/credits/success?session_id={CHECKOUT_SESSION_ID}`,
 *   cancel_url: `${baseUrl}/credits/cancel`,
 * });
 * ```
 */
export function createCreditsPurchaseSession(
  orgId: OrgId,
  _amountCents: number,
): StripeCheckoutResult {
  const org = getOrg(orgId);
  if (!org) {
    throw new Error(`Org ${orgId} not found`);
  }

  // Placeholder — replace with real Stripe call
  const sessionId = `cs_${Date.now().toString(36)}`;
  return {
    checkoutUrl: `https://checkout.stripe.com/pay/${sessionId}`,
    sessionId,
  };
}

// ── Auto Top-Up Processing ───────────────────────────────────────────────────

/**
 * Process pending auto-top-up requests.
 *
 * Called periodically (e.g., every 60 seconds) to process the queue
 * of orgs that need auto-top-up. In production, this charges the
 * saved Stripe payment method.
 *
 * ```
 * const paymentIntent = await stripe.paymentIntents.create({
 *   amount: config.topUpAmountCents,
 *   currency: "usd",
 *   customer: org.stripeCustomerId,
 *   payment_method: config.stripePaymentMethodId,
 *   off_session: true,
 *   confirm: true,
 *   metadata: { orgId, type: "auto_topup" },
 * });
 * ```
 */
export function processAutoTopUpQueue(): number {
  let processed = 0;

  while (autoTopUpQueue.length > 0) {
    const request = autoTopUpQueue.shift();
    if (!request) {
      break;
    }

    const config = getAutoTopUp(request.orgId);
    if (!config?.enabled) {
      continue;
    }

    // In production: charge Stripe, then add credits on success
    // For now: simulate immediate success
    addCredits(request.orgId, request.amountCents, "auto_topup", "Auto top-up");
    processed++;
  }

  return processed;
}

// ── Webhook Handlers ─────────────────────────────────────────────────────────

/**
 * Handle Stripe webhook events.
 *
 * In production, verify the webhook signature first:
 * ```
 * const event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
 * ```
 */
export function handleStripeEvent(
  eventType: string,
  data: Record<string, unknown>,
): { handled: boolean; action?: string } {
  switch (eventType) {
    case "checkout.session.completed": {
      const metadata = data.metadata as Record<string, string> | undefined;
      if (metadata?.orgId && metadata?.amountCents) {
        addCredits(
          metadata.orgId as OrgId,
          Number(metadata.amountCents),
          "stripe",
          "Credit purchase via Stripe Checkout",
        );
        return { handled: true, action: "credits_added" };
      }
      return { handled: false };
    }

    case "payment_intent.succeeded": {
      const metadata = data.metadata as Record<string, string> | undefined;
      if (metadata?.type === "auto_topup" && metadata?.orgId) {
        addCredits(
          metadata.orgId as OrgId,
          Number(metadata.amountCents ?? 0),
          "auto_topup",
          "Auto top-up payment succeeded",
        );
        return { handled: true, action: "auto_topup_credited" };
      }
      return { handled: false };
    }

    case "payment_intent.payment_failed": {
      const metadata = data.metadata as Record<string, string> | undefined;
      if (metadata?.type === "auto_topup" && metadata?.orgId) {
        // In production: notify the org, disable auto-top-up, alert agents
        return { handled: true, action: "auto_topup_failed" };
      }
      return { handled: false };
    }

    default:
      return { handled: false };
  }
}

// ── Payment History ──────────────────────────────────────────────────────────

const paymentLog: PaymentRecord[] = [];

export function recordPayment(orgId: OrgId, amountCents: number, stripeId: string | null): void {
  paymentLog.push({
    id: `pay_${Date.now().toString(36)}`,
    orgId,
    amountCents,
    status: "succeeded",
    stripePaymentIntentId: stripeId,
    createdAt: new Date(),
  });
}

export function getPaymentHistory(orgId: OrgId): PaymentRecord[] {
  return paymentLog.filter((p) => p.orgId === orgId);
}
