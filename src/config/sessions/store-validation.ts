/**
 * Session store validation utilities.
 *
 * Validates session entries against current configuration to prevent
 * stale provider/model references from causing runtime errors.
 */

import type { OpenClawConfig } from "../config.js";
import type { SessionEntry } from "./types.js";

/**
 * Get list of configured provider IDs from the current configuration.
 */
function listConfiguredProviderIds(cfg: OpenClawConfig): string[] {
  const providers = cfg.models?.providers;
  if (!providers || typeof providers !== "object") {
    return [];
  }
  return Object.keys(providers);
}

/**
 * Validate and sanitize a session entry's model/provider overrides.
 *
 * If the session references a provider that is no longer configured,
 * clear the override fields to prevent runtime errors.
 *
 * @param entry - The session entry to validate (mutated in place)
 * @param cfg - Current OpenClaw configuration
 * @returns true if the entry was modified, false otherwise
 */
export function validateAndSanitizeSessionEntry(entry: SessionEntry, cfg: OpenClawConfig): boolean {
  const configuredProviders = new Set(listConfiguredProviderIds(cfg));
  let modified = false;

  // Validate modelOverride/providerOverride
  if (entry.providerOverride || entry.modelOverride) {
    const provider = entry.providerOverride?.trim();
    if (provider && !configuredProviders.has(provider)) {
      // Provider override references a removed provider — clear both fields
      delete entry.providerOverride;
      delete entry.modelOverride;
      modified = true;
    }
  }

  // Validate runtime model/modelProvider fields
  if (entry.modelProvider || entry.model) {
    const provider = entry.modelProvider?.trim();
    if (provider && !configuredProviders.has(provider)) {
      // Runtime model references a removed provider — clear both fields
      delete entry.modelProvider;
      delete entry.model;
      modified = true;
    }
  }

  return modified;
}

/**
 * Validate all entries in a session store.
 *
 * @param store - The session store object (mutated in place)
 * @param cfg - Current OpenClaw configuration
 * @returns Number of entries that were modified
 */
export function validateSessionStore(
  store: Record<string, SessionEntry>,
  cfg: OpenClawConfig,
): number {
  let modifiedCount = 0;

  for (const entry of Object.values(store)) {
    if (validateAndSanitizeSessionEntry(entry, cfg)) {
      modifiedCount++;
    }
  }

  return modifiedCount;
}
