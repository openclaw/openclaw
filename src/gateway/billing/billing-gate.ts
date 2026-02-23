/**
 * Billing gate — checks whether a request is allowed to proceed
 * based on the tenant's subscription status AND prepaid balance.
 *
 * When billing is not applicable (non-IAM mode, no tenant), the gate
 * always allows the request.
 */

import type { GatewayIamConfig } from "../../config/config.js";
import type { TenantContext } from "../tenant-context.js";
import {
  getSubscriptionStatus,
  getBalance,
  type SubscriptionStatus,
} from "./iam-billing-client.js";

export type BillingGateResult =
  | { allowed: true }
  | { allowed: false; reason: string; status: SubscriptionStatus };

/**
 * Check whether the tenant is allowed to make an LLM request.
 *
 * Returns `{ allowed: true }` when:
 * - No IAM config (personal / self-hosted mode)
 * - No tenant context (personal / self-hosted mode)
 * - Tenant has prepaid credit balance > 0
 *
 * Returns `{ allowed: false, reason }` when balance is zero
 * or billing service is unreachable (fail-closed for billing).
 */
export async function checkBillingAllowance(params: {
  iamConfig?: GatewayIamConfig | null;
  tenant?: TenantContext | null;
  /** Optional JWT token for authenticated billing API calls. */
  token?: string;
}): Promise<BillingGateResult> {
  // Non-IAM mode — billing not enforced.
  if (!params.iamConfig || !params.tenant) {
    return { allowed: true };
  }

  // BILLING_GATE_MODE controls error behavior:
  //   "open" — always allow (development/testing)
  //   "warn" — allow on error but log warning (staging)
  //   unset  — fail-closed (production default)
  const gateMode = process.env.BILLING_GATE_MODE;
  if (gateMode === "open") {
    return { allowed: true };
  }

  try {
    // Check prepaid balance — primary billing gate
    const userId = params.tenant.userId || params.tenant.orgId;
    const available = await getBalance(params.iamConfig, userId, params.token);

    if (available > 0) {
      return { allowed: true };
    }

    // No balance — check subscription as fallback (some plans may not require prepaid)
    const status = await getSubscriptionStatus(params.iamConfig, params.tenant, params.token);
    if (status.active) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Insufficient funds — add credits to continue. Balance: $${(available / 100).toFixed(2)}`,
      status,
    };
  } catch (err) {
    console.error(
      `[billing-gate] Failed to check billing for "${params.tenant.orgId}": ${err instanceof Error ? err.message : String(err)}`,
    );

    // In warn mode, allow requests when Commerce API is unreachable.
    if (gateMode === "warn") {
      console.warn("[billing-gate] Commerce unreachable — allowing in warn mode");
      return { allowed: true };
    }

    // Default: fail-closed for billing safety.
    return {
      allowed: false,
      reason: "Billing service unavailable — please try again",
      status: { active: false, subscription: null, plan: null },
    };
  }
}
