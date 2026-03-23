/**
 * Policy feedback configuration: defaults, loading, saving, and merging.
 *
 * The config layer manages the PolicyFeedbackConfig with sensible defaults,
 * environment variable overrides, and per-agent override merging.
 */

import { readPolicyConfig, writePolicyConfig } from "./persistence.js";
import type { PolicyFeedbackConfig, PolicyFeedbackFeatureFlags, PolicyMode } from "./types.js";

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

/** Default policy feedback configuration. */
export function getDefaultConfig(): PolicyFeedbackConfig {
  return {
    mode: "passive",
    aggregateIntervalMs: 3_600_000, // 1 hour
    outcomeHorizons: [60_000, 1_800_000, 86_400_000], // 1min, 30min, 24h
    constraints: [],
    logRetentionDays: 90,
    perAgentScoping: true,
  };
}

/** Default feature flags (everything enabled in passive mode). */
export function getDefaultFeatureFlags(): PolicyFeedbackFeatureFlags {
  return {
    enableActionLogging: true,
    enableOutcomeLogging: true,
    enableRanking: true,
    enableConstraints: true,
  };
}

// ---------------------------------------------------------------------------
// Feature flags derived from mode
// ---------------------------------------------------------------------------

/**
 * Derive feature flags from the operating mode.
 * In "off" mode, all features are disabled.
 * In "passive" mode, logging is enabled but ranking and constraints are
 * still available for internal use (they just don't influence behavior).
 */
export function featureFlagsForMode(mode: PolicyMode): PolicyFeedbackFeatureFlags {
  if (mode === "off") {
    return {
      enableActionLogging: false,
      enableOutcomeLogging: false,
      enableRanking: false,
      enableConstraints: false,
    };
  }

  // passive, advisory, and active all enable everything
  return getDefaultFeatureFlags();
}

// ---------------------------------------------------------------------------
// Environment variable override
// ---------------------------------------------------------------------------

const ENV_MODE_KEY = "OPENCLAW_POLICY_FEEDBACK_MODE";
const VALID_MODES: ReadonlySet<string> = new Set<PolicyMode>([
  "off",
  "passive",
  "advisory",
  "active",
]);

/**
 * Read the policy mode from the environment variable, if set.
 * Returns undefined when the env var is absent or has an invalid value.
 */
export function readModeFromEnv(
  env: Record<string, string | undefined> = process.env,
): PolicyMode | undefined {
  const raw = env[ENV_MODE_KEY];
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (VALID_MODES.has(normalized)) {
    return normalized as PolicyMode;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/**
 * Load the effective policy feedback config.
 *
 * Priority (highest to lowest):
 * 1. Environment variable override for `mode`
 * 2. Persisted runtime config file (~/.openclaw/policy-feedback/policy-config.json)
 * 3. Defaults
 */
export async function loadConfig(options?: {
  home?: string;
  env?: Record<string, string | undefined>;
}): Promise<PolicyFeedbackConfig> {
  const defaults = getDefaultConfig();
  const persisted = await readPolicyConfig({ home: options?.home });
  const merged = mergeConfig(defaults, persisted ?? {});

  // Environment variable takes highest precedence for mode
  const envMode = readModeFromEnv(options?.env);
  if (envMode !== undefined) {
    merged.mode = envMode;
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Config saving
// ---------------------------------------------------------------------------

/** Persist the policy feedback config to disk. */
export async function saveConfig(
  config: PolicyFeedbackConfig,
  options?: { home?: string },
): Promise<void> {
  await writePolicyConfig(config, { home: options?.home });
}

// ---------------------------------------------------------------------------
// Config merging
// ---------------------------------------------------------------------------

/**
 * Merge a partial config over a base config. Shallow merge at the top level;
 * arrays and nested objects are replaced, not deep-merged.
 */
export function mergeConfig(
  base: PolicyFeedbackConfig,
  overrides: Partial<PolicyFeedbackConfig>,
): PolicyFeedbackConfig {
  return { ...base, ...stripUndefined(overrides) };
}

/**
 * Merge per-agent overrides into a base config.
 * Looks up `agentId` in the config's `agentOverrides` map and merges if found.
 */
export function resolveAgentConfig(
  base: PolicyFeedbackConfig,
  agentId: string,
): PolicyFeedbackConfig {
  const agentOverride = base.agentOverrides?.[agentId];
  if (!agentOverride) {
    return base;
  }
  return mergeConfig(base, agentOverride);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Remove keys whose value is `undefined` from an object.
 * This prevents `{ ...base, key: undefined }` from clobbering base values.
 */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as Partial<T>;
}
