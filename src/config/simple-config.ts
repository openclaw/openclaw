import type { AgentModelConfig } from "./types.agents-shared.js";

/**
 * Resilience configuration for model failover behavior.
 * Controls how model switches, billing failures, and config propagation
 * are handled.
 */
export type ResilienceConfig = {
  /** Automatically switch to fallback model on failure. */
  autoFailover?: boolean;
  /** Sanitize tool call IDs when switching models mid-session (Bug #1 fix). */
  sanitizeOnSwitch?: boolean;
  /** Notify user when failover occurs. */
  notifyOnFailover?: boolean;
  /** Return a helpful message instead of crashing when all models fail (Bug #2 fix). */
  gracefulDegradation?: boolean;
  /** Propagate model changes to all stores (Bug #3 fix). */
  propagateChanges?: boolean;
};

export type SimpleConfigProfile = "simple" | "resilient" | "commercial";

type CommercialConfigInput = {
  reasoningModel: string;
  codingModel: string;
  budgetModel: string;
  monthlyBudget?: number;
};

type GeneratedModelConfig = {
  model: AgentModelConfig;
  resilience?: ResilienceConfig;
};

const PROFILE_DESCRIPTIONS: Record<SimpleConfigProfile, string> = {
  simple: "Single model, minimal configuration",
  resilient: "Primary model with automatic failover (recommended)",
  commercial: "Cost-optimized with routing and monitoring",
};

/**
 * Generate a model config section from a simplified profile.
 *
 * Instead of manually constructing the nested config, users select a profile
 * and provide the minimal required inputs.
 */
export function generateSimpleModelConfig(
  profile: "simple",
  primaryModel: string,
): GeneratedModelConfig;
export function generateSimpleModelConfig(
  profile: "resilient",
  primaryModel: string,
  fallbacks: string[],
): GeneratedModelConfig;
export function generateSimpleModelConfig(
  profile: "commercial",
  config: CommercialConfigInput,
): GeneratedModelConfig;
export function generateSimpleModelConfig(
  profile: SimpleConfigProfile,
  primaryOrConfig: string | CommercialConfigInput,
  fallbacks?: string[],
): GeneratedModelConfig {
  switch (profile) {
    case "simple": {
      const primary = primaryOrConfig as string;
      return {
        model: primary.trim(),
      };
    }

    case "resilient": {
      const primary = primaryOrConfig as string;
      const fallbackList = fallbacks ?? [];
      return {
        model: {
          primary: primary.trim(),
          fallbacks: fallbackList.map((f) => f.trim()),
        },
        resilience: {
          autoFailover: true,
          sanitizeOnSwitch: true,
          notifyOnFailover: true,
          gracefulDegradation: true,
          propagateChanges: true,
        },
      };
    }

    case "commercial": {
      const config = primaryOrConfig as CommercialConfigInput;
      return {
        model: {
          primary: config.reasoningModel.trim(),
          fallbacks: [config.codingModel.trim(), config.budgetModel.trim()],
        },
        resilience: {
          autoFailover: true,
          sanitizeOnSwitch: true,
          notifyOnFailover: true,
          gracefulDegradation: true,
          propagateChanges: true,
        },
      };
    }
  }
}

/**
 * Get available config profile descriptions for onboarding UIs.
 */
export function getConfigProfileDescriptions(): Array<{
  profile: SimpleConfigProfile;
  description: string;
}> {
  return Object.entries(PROFILE_DESCRIPTIONS).map(([profile, description]) => ({
    profile: profile as SimpleConfigProfile,
    description,
  }));
}
