/**
 * Tier-to-model routing for Hanzo bot via Zen API Gateway.
 * Free tier (developer): zen4.1 → Claude Sonnet 4.6 on DO-AI (cheap)
 * Paid tier (pro/team/enterprise): zen4-pro → Kimi K2.5 on Fireworks (premium)
 */

export type PlanTier = "developer" | "pro" | "team" | "enterprise";

export interface ModelRef {
  provider: string;
  model: string;
}

const TIER_MODELS: Record<PlanTier, ModelRef> = {
  developer: { provider: "hanzo", model: "zen4.1" },
  pro: { provider: "hanzo", model: "zen4-pro" },
  team: { provider: "hanzo", model: "zen4-pro" },
  enterprise: { provider: "hanzo", model: "zen4-pro" },
};

export function resolveTierDefaultModel(tier: PlanTier): ModelRef {
  return TIER_MODELS[tier] ?? TIER_MODELS.developer;
}

export function shouldUpgradeModel(opts: {
  tier: PlanTier;
  currentProvider: string;
  currentModel: string;
}): ModelRef | null {
  const { tier, currentProvider, currentModel } = opts;
  // Only upgrade if user is on the free-tier default -- respect explicit overrides
  if (currentProvider !== "hanzo" || currentModel !== "zen4.1") {
    return null;
  }
  if (tier === "developer") {
    return null; // Already on free tier model
  }
  return TIER_MODELS[tier] ?? null;
}
