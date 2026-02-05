/**
 * Provider detection logic.
 * Detects which LLM providers are configured/available.
 */

import type { AuthProfileStore, AuthProfileCredential } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ProviderStatus, TokenValidity } from "./types.js";
import { ensureAuthProfileStore, listProfilesForProvider } from "../../agents/auth-profiles.js";
import {
  getCustomProviderApiKey,
  resolveAwsSdkEnvVarName,
  resolveEnvApiKey,
} from "../../agents/model-auth.js";
import { loadConfig } from "../../config/config.js";
import { PROVIDER_REGISTRY, getProviderById } from "./registry.js";

/**
 * Get token validity information from a credential.
 */
function getTokenValidity(credential?: AuthProfileCredential): {
  validity: TokenValidity;
  expiresAt?: string;
  expiresIn?: string;
} {
  if (!credential) {
    return { validity: "unknown" };
  }

  // Only token and oauth types have expiration
  if (credential.type !== "token" && credential.type !== "oauth") {
    return { validity: "unknown" };
  }

  // Get expiration timestamp
  let expiresMs: number | undefined;
  if (credential.type === "token" && credential.expires) {
    expiresMs = credential.expires;
  } else if (credential.type === "oauth" && credential.expires) {
    expiresMs = credential.expires;
  }

  if (!expiresMs) {
    return { validity: "unknown" };
  }

  const now = Date.now();
  const expiresAt = new Date(expiresMs).toISOString();

  if (expiresMs <= now) {
    return { validity: "expired", expiresAt, expiresIn: "expired" };
  }

  const remainingMs = expiresMs - now;
  const expiresIn = formatDuration(remainingMs);

  // Consider "expiring" if less than 24 hours remaining
  const EXPIRING_THRESHOLD_MS = 24 * 60 * 60 * 1000;
  if (remainingMs < EXPIRING_THRESHOLD_MS) {
    return { validity: "expiring", expiresAt, expiresIn };
  }

  return { validity: "valid", expiresAt, expiresIn };
}

/**
 * Format duration in human-readable form.
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

export type DetectionOptions = {
  /** Include providers that were not detected */
  includeNotDetected?: boolean;
  /** Only detect specific providers */
  providerIds?: string[];
  /** Custom config (defaults to loaded config) */
  config?: OpenClawConfig;
  /** Custom auth store */
  authStore?: AuthProfileStore;
};

/**
 * Detect all known LLM providers and their configuration status.
 */
export function detectProviders(options: DetectionOptions = {}): ProviderStatus[] {
  const cfg = options.config ?? loadConfig();
  const authStore = options.authStore ?? ensureAuthProfileStore();
  const results: ProviderStatus[] = [];

  const providersToCheck = options.providerIds
    ? PROVIDER_REGISTRY.filter((p) => options.providerIds!.includes(p.id))
    : PROVIDER_REGISTRY;

  for (const provider of providersToCheck) {
    const status = detectProvider(provider.id, cfg, authStore);
    if (status.detected || options.includeNotDetected) {
      results.push(status);
    }
  }

  // Sort: detected first, then alphabetically
  results.sort((a, b) => {
    if (a.detected !== b.detected) {
      return a.detected ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return results;
}

/**
 * Detect a single provider's configuration status.
 */
export function detectProvider(
  providerId: string,
  cfg?: OpenClawConfig,
  authStore?: AuthProfileStore,
): ProviderStatus {
  const config = cfg ?? loadConfig();
  const store = authStore ?? ensureAuthProfileStore();
  const definition = getProviderById(providerId);

  if (!definition) {
    return {
      id: providerId,
      name: providerId,
      detected: false,
      authSource: null,
      error: "Unknown provider",
    };
  }

  // Check auth profiles first (most explicit)
  const profileIds = listProfilesForProvider(store, providerId);
  if (profileIds.length > 0) {
    const profileIdsStr = profileIds.join(", ");
    const firstProfileId = profileIds[0];
    const credential = store.profiles?.[firstProfileId];
    const usageStats = store.usageStats?.[firstProfileId];

    // Determine auth mode from credential type
    const authMode = credential
      ? credential.type === "api_key"
        ? "api-key"
        : credential.type === "oauth"
          ? "oauth"
          : credential.type === "token"
            ? "token"
            : "unknown"
      : "unknown";

    // Calculate token validity
    const { validity, expiresAt, expiresIn } = getTokenValidity(credential);

    // Check cooldown
    const inCooldown = usageStats?.cooldownUntil ? usageStats.cooldownUntil > Date.now() : false;
    const cooldownEndsAt = usageStats?.cooldownUntil
      ? new Date(usageStats.cooldownUntil).toISOString()
      : undefined;

    // Last used
    const lastUsed = usageStats?.lastUsed ? new Date(usageStats.lastUsed).toISOString() : undefined;

    return {
      id: definition.id,
      name: definition.name,
      detected: true,
      authSource: "auth-profile",
      authDetail: profileIdsStr,
      authMode,
      tokenValidity: validity,
      tokenExpiresAt: expiresAt,
      tokenExpiresIn: expiresIn,
      lastUsed,
      inCooldown,
      cooldownEndsAt: inCooldown ? cooldownEndsAt : undefined,
    };
  }

  // Check AWS SDK for Bedrock
  if (providerId === "amazon-bedrock") {
    const awsEnvVar = resolveAwsSdkEnvVarName();
    if (awsEnvVar) {
      return {
        id: definition.id,
        name: definition.name,
        detected: true,
        authSource: "aws-sdk",
        authDetail: awsEnvVar,
        authMode: "aws-sdk",
      };
    }
  }

  // Check environment variables
  const envResult = resolveEnvApiKey(providerId);
  if (envResult) {
    return {
      id: definition.id,
      name: definition.name,
      detected: true,
      authSource: "env",
      authDetail: envResult.source,
      authMode: definition.authModes[0] ?? "api-key",
    };
  }

  // Check config-based API key
  const configKey = getCustomProviderApiKey(config, providerId);
  if (configKey) {
    return {
      id: definition.id,
      name: definition.name,
      detected: true,
      authSource: "config",
      authDetail: "models.providers." + providerId + ".apiKey",
      authMode: definition.authModes[0] ?? "api-key",
    };
  }

  // Check for custom base URL (might be local provider)
  const providerConfig = config?.models?.providers?.[providerId];
  if (providerConfig?.baseUrl) {
    // For local providers like Ollama, having a base URL is enough
    if (definition.isLocal) {
      return {
        id: definition.id,
        name: definition.name,
        detected: true,
        authSource: "config",
        authDetail: "models.providers." + providerId + ".baseUrl",
        baseUrl: providerConfig.baseUrl,
        authMode: definition.authModes[0] ?? "api-key",
      };
    }
  }

  // Not detected
  return {
    id: definition.id,
    name: definition.name,
    detected: false,
    authSource: null,
  };
}

/**
 * Check if a provider is detected/configured.
 */
export function isProviderDetected(
  providerId: string,
  cfg?: OpenClawConfig,
  authStore?: AuthProfileStore,
): boolean {
  const status = detectProvider(providerId, cfg, authStore);
  return status.detected;
}

/**
 * Get all detected provider IDs.
 */
export function getDetectedProviderIds(
  cfg?: OpenClawConfig,
  authStore?: AuthProfileStore,
): string[] {
  const providers = detectProviders({
    config: cfg,
    authStore,
    includeNotDetected: false,
  });
  return providers.map((p) => p.id);
}

/**
 * Get detection summary for display.
 */
export function getDetectionSummary(options: DetectionOptions = {}): {
  detected: number;
  total: number;
  providers: ProviderStatus[];
} {
  const providers = detectProviders({ ...options, includeNotDetected: true });
  const detected = providers.filter((p) => p.detected).length;
  return {
    detected,
    total: providers.length,
    providers,
  };
}
