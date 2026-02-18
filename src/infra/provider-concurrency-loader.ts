/**
 * Provider Concurrency Configuration Loader
 *
 * Loads concurrency limits from OpenClaw config and applies them to the provider concurrency limiter.
 */

import type { OpenClawConfig } from "../config/types.js";
import {
  providerConcurrencyLimiter,
  type ProviderConcurrencyLimits,
} from "./provider-concurrency-limiter.js";

/**
 * Load provider concurrency configuration from OpenClaw config
 */
export function loadProviderConcurrencyConfig(config: OpenClawConfig): void {
  const limits: ProviderConcurrencyLimits = {};

  // Apply default concurrency config if provided
  if (config.models?.defaultConcurrency) {
    limits.default = config.models.defaultConcurrency;
  }

  // Apply provider-specific configs
  if (config.models?.providers) {
    limits.providers = {};

    for (const [providerId, providerConfig] of Object.entries(config.models.providers)) {
      if (providerConfig.concurrency) {
        limits.providers[providerId] = providerConfig.concurrency;
      }

      // Also index by baseUrl host if available
      if (providerConfig.baseUrl && providerConfig.concurrency) {
        try {
          const url = new URL(providerConfig.baseUrl);
          limits.providers[url.host] = providerConfig.concurrency;
        } catch {
          // Invalid URL, skip
        }
      }
    }
  }

  // Configure the global limiter
  providerConcurrencyLimiter.configure(limits);
}
