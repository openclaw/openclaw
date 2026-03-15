/**
 * Secret registry and configuration manager.
 * Reads secret definitions from openclaw.json under `secrets.registry`.
 */

import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.js";

/**
 * Secret access tier.
 */
export type SecretTier = "open" | "controlled" | "restricted";

/**
 * Secret definition from registry.
 */
export interface SecretDefinition {
  name: string;
  tier: SecretTier;
  description?: string;
  ttl?: number; // Override default TTL (minutes)
  maxTtl?: number; // Override max TTL (minutes)
  type?: string; // Secret type (e.g., "api_key", "github_pat")
  hint?: string; // Human-readable description for agent
  capabilities?: string[]; // What this secret can do
  /**
   * OS-level agent blind: secret lives in a separate user keychain (sirbam's
   * bamwerks keychain) and is NEVER directly readable by the openclaw process.
   * Access is exclusively via the privileged secrets-broker (runs as sirbam via
   * sudoers), which injects the value via stdout pipe only.
   *
   * When true, getSecret() routes through the OS broker instead of the vault
   * backend. openclaw receives the value only for the duration of the operation.
   */
  agentBlind?: boolean;
}

/**
 * Tier configuration with defaults.
 */
export interface TierConfig {
  tier: SecretTier;
  defaultTtl: number; // minutes (0 = unlimited)
  maxTtl: number; // minutes (0 = unlimited)
  requiresApproval: boolean;
  description: string;
}

/**
 * Default tier configurations.
 */
const DEFAULT_TIER_CONFIGS: Record<SecretTier, TierConfig> = {
  open: {
    tier: "open",
    defaultTtl: 0, // Unlimited
    maxTtl: 0, // Unlimited
    requiresApproval: false,
    description: "Public, read-only, low-risk secrets (no approval needed)",
  },
  controlled: {
    tier: "controlled",
    defaultTtl: 240, // 4 hours
    maxTtl: 480, // 8 hours
    requiresApproval: true,
    description: "Moderate risk, session-scoped secrets (TOTP once per session)",
  },
  restricted: {
    tier: "restricted",
    defaultTtl: 15, // 15 minutes
    maxTtl: 60, // 1 hour
    requiresApproval: true,
    description: "High risk, write/admin access (TOTP each time)",
  },
};

/**
 * Get the secrets registry from config.
 * @param config OpenClaw configuration (optional, loads if not provided)
 * @returns Array of secret definitions
 */
export function getRegistry(config?: OpenClawConfig): SecretDefinition[] {
  const cfg = config ?? loadConfig();

  // Read from config.secrets.registry
  const registry = (cfg as Record<string, unknown>).secrets
    ? (cfg as Record<string, Record<string, unknown>>).secrets.registry
    : undefined;

  if (!Array.isArray(registry)) {
    return [];
  }

  type RegistryEntry = Record<string, unknown>;
  const validEntries = registry.filter(
    (entry): entry is RegistryEntry =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as RegistryEntry).name === "string" &&
      typeof (entry as RegistryEntry).tier === "string",
  );
  return validEntries.map((entry) => ({
    name: entry.name as string,
    tier: normalizeTier(entry.tier as string),
    description: typeof entry.description === "string" ? entry.description : undefined,
    ttl: typeof entry.ttl === "number" ? entry.ttl : undefined,
    maxTtl: typeof entry.maxTtl === "number" ? entry.maxTtl : undefined,
    type: typeof entry.type === "string" ? entry.type : undefined,
    hint: typeof entry.hint === "string" ? entry.hint : undefined,
    capabilities: Array.isArray(entry.capabilities) ? (entry.capabilities as string[]) : undefined,
  }));
}

/**
 * Get a specific secret definition by name.
 * @param name Secret name
 * @param config OpenClaw configuration (optional)
 * @returns Secret definition or null if not found
 */
export function getSecretDef(name: string, config?: OpenClawConfig): SecretDefinition | null {
  const registry = getRegistry(config);
  return registry.find((s) => s.name === name) ?? null;
}

/**
 * Get tier configuration with defaults and overrides.
 * @param tier Secret tier
 * @param secretDef Optional secret definition for overrides
 * @returns Tier configuration
 */
export function getTierConfig(tier: SecretTier, secretDef?: SecretDefinition): TierConfig {
  const base = DEFAULT_TIER_CONFIGS[tier];

  if (!secretDef) {
    return base;
  }

  // Apply secret-specific overrides
  return {
    ...base,
    defaultTtl: secretDef.ttl ?? base.defaultTtl,
    maxTtl: secretDef.maxTtl ?? base.maxTtl,
  };
}

/**
 * Get all tier configurations.
 */
export function getAllTierConfigs(): Record<SecretTier, TierConfig> {
  return { ...DEFAULT_TIER_CONFIGS };
}

/**
 * Normalize tier string to valid SecretTier.
 * Defaults to 'restricted' for unknown values.
 */
export function normalizeTier(tier: string): SecretTier {
  const normalized = tier.toLowerCase().trim();

  if (normalized === "open") {
    return "open";
  }
  if (normalized === "controlled") {
    return "controlled";
  }
  if (normalized === "restricted") {
    return "restricted";
  }

  // Default to most restrictive
  return "restricted";
}

/**
 * Check if a tier requires approval.
 */
export function requiresApproval(tier: SecretTier): boolean {
  return DEFAULT_TIER_CONFIGS[tier].requiresApproval;
}

/**
 * Validate and cap TTL against tier limits.
 * @param tier Secret tier
 * @param requestedTtl Requested TTL in minutes
 * @param secretDef Optional secret definition for custom limits
 * @returns Capped TTL
 */
export function capTtl(
  tier: SecretTier,
  requestedTtl: number,
  secretDef?: SecretDefinition,
): number {
  const config = getTierConfig(tier, secretDef);

  // If unlimited (0), allow any value
  if (config.maxTtl === 0) {
    return requestedTtl;
  }

  // Cap to max
  return Math.min(requestedTtl, config.maxTtl);
}

/**
 * Get default TTL for a tier.
 * @param tier Secret tier
 * @param secretDef Optional secret definition for custom TTL
 * @returns Default TTL in minutes
 */
export function getDefaultTtl(tier: SecretTier, secretDef?: SecretDefinition): number {
  const config = getTierConfig(tier, secretDef);
  return config.defaultTtl;
}

/**
 * Check if a secret name exists in the registry.
 */
export function isRegistered(name: string, config?: OpenClawConfig): boolean {
  return getSecretDef(name, config) !== null;
}

/**
 * List all registered secret names.
 */
export function listSecretNames(config?: OpenClawConfig): string[] {
  return getRegistry(config).map((s) => s.name);
}

/**
 * Get secrets grouped by tier.
 */
export function getSecretsByTier(config?: OpenClawConfig): Record<SecretTier, SecretDefinition[]> {
  const registry = getRegistry(config);

  return {
    open: registry.filter((s) => s.tier === "open"),
    controlled: registry.filter((s) => s.tier === "controlled"),
    restricted: registry.filter((s) => s.tier === "restricted"),
  };
}
