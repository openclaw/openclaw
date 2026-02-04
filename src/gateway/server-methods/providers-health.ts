/**
 * Gateway handler for providers.health endpoint.
 * Composes detection, auth health, profile health, and usage data
 * into a single response per provider.
 */

import type { GatewayRequestHandlers } from "./types.js";
import { buildAuthHealthSummary } from "../../agents/auth-health.js";
import { ensureAuthProfileStore, listProfilesForProvider } from "../../agents/auth-profiles.js";
import { getProfileHealthStatus } from "../../agents/auth-profiles/usage.js";
import { detectProviders } from "../../commands/providers/detection.js";
import { getProviderById } from "../../commands/providers/registry.js";
import { loadConfig } from "../../config/config.js";
import { loadProviderUsageSummary } from "../../infra/provider-usage.load.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateProvidersHealthParams,
  type ProviderHealthEntry,
} from "../protocol/index.js";

export const providersHealthHandlers: GatewayRequestHandlers = {
  "providers.health": async ({ params, respond }) => {
    if (!validateProvidersHealthParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid providers.health params: ${formatValidationErrors(validateProvidersHealthParams.errors)}`,
        ),
      );
      return;
    }

    try {
      const typedParams = params as { all?: boolean; includeUsage?: boolean };
      const includeAll = typedParams.all ?? false;
      const includeUsage = typedParams.includeUsage ?? true;

      const cfg = loadConfig();
      const authStore = ensureAuthProfileStore();

      // 1. Detect providers
      const detected = detectProviders({
        includeNotDetected: includeAll,
        config: cfg,
        authStore,
      });

      // 2. Build auth health summary
      const authHealth = buildAuthHealthSummary({ store: authStore, cfg });

      // 3. Load usage summary (best-effort with timeout)
      let usageByProvider: Map<
        string,
        {
          windows: Array<{ label: string; usedPercent: number; resetAt?: number }>;
          plan?: string;
          error?: string;
        }
      > = new Map();

      if (includeUsage) {
        try {
          const usage = await loadProviderUsageSummary({ timeoutMs: 8000 });
          for (const entry of usage.providers) {
            usageByProvider.set(entry.provider, {
              windows: entry.windows.map((w) => ({
                label: w.label,
                usedPercent: w.usedPercent,
                resetAt: w.resetAt,
              })),
              plan: entry.plan,
              error: entry.error,
            });
          }
        } catch {
          // Usage loading is best-effort; proceed without it
        }
      }

      // 4. Build auth health by provider for quick lookup
      const authByProvider = new Map(authHealth.providers.map((p) => [p.provider, p]));

      // 5. Compose final entries
      const now = Date.now();
      const providers: ProviderHealthEntry[] = detected.map((provider) => {
        const definition = getProviderById(provider.id);
        const authProvider = authByProvider.get(provider.id);

        // Get profile health status (cooldown, errors)
        const profileIds = listProfilesForProvider(authStore, provider.id);
        let profileHealth: {
          status: string;
          errorCount: number;
          cooldownRemainingMs: number;
          disabledReason?: string;
        } = { status: "healthy", errorCount: 0, cooldownRemainingMs: 0 };

        if (profileIds.length > 0) {
          profileHealth = getProfileHealthStatus(authStore, profileIds[0]);
        }

        // Determine overall health status
        let healthStatus = "healthy";
        if (!provider.detected) {
          healthStatus = "missing";
        } else if (profileHealth.status === "disabled") {
          healthStatus = "disabled";
        } else if (profileHealth.status === "cooldown") {
          healthStatus = "cooldown";
        } else if (provider.tokenValidity === "expired" || authProvider?.status === "expired") {
          healthStatus = "expired";
        } else if (
          profileHealth.status === "warning" ||
          provider.tokenValidity === "expiring" ||
          authProvider?.status === "expiring"
        ) {
          healthStatus = "warning";
        }

        // Token expiration in ms
        let tokenExpiresAtMs: number | undefined;
        let tokenRemainingMs: number | undefined;
        if (authProvider?.expiresAt) {
          tokenExpiresAtMs = authProvider.expiresAt;
          tokenRemainingMs = Math.max(0, authProvider.expiresAt - now);
        } else if (provider.tokenExpiresAt) {
          const ts = new Date(provider.tokenExpiresAt).getTime();
          if (Number.isFinite(ts)) {
            tokenExpiresAtMs = ts;
            tokenRemainingMs = Math.max(0, ts - now);
          }
        }

        // Cooldown end timestamp
        let cooldownEndsAtMs: number | undefined;
        if (provider.cooldownEndsAt) {
          const ts = new Date(provider.cooldownEndsAt).getTime();
          if (Number.isFinite(ts)) {
            cooldownEndsAtMs = ts;
          }
        }

        // Usage data
        const usage = usageByProvider.get(provider.id);

        const entry: ProviderHealthEntry = {
          id: provider.id,
          name: provider.name,
          detected: provider.detected,
          healthStatus,
          ...(provider.authSource ? { authSource: String(provider.authSource) } : {}),
          ...(provider.authMode ? { authMode: provider.authMode } : {}),
          ...(provider.tokenValidity ? { tokenValidity: provider.tokenValidity } : {}),
          ...(tokenExpiresAtMs ? { tokenExpiresAt: tokenExpiresAtMs } : {}),
          ...(tokenRemainingMs !== undefined ? { tokenRemainingMs } : {}),
          ...(provider.inCooldown ? { inCooldown: true } : {}),
          ...(profileHealth.cooldownRemainingMs > 0
            ? { cooldownRemainingMs: profileHealth.cooldownRemainingMs }
            : {}),
          ...(cooldownEndsAtMs ? { cooldownEndsAt: cooldownEndsAtMs } : {}),
          ...(profileHealth.errorCount > 0 ? { errorCount: profileHealth.errorCount } : {}),
          ...(profileHealth.disabledReason ? { disabledReason: profileHealth.disabledReason } : {}),
          ...(provider.lastUsed ? { lastUsed: provider.lastUsed } : {}),
          ...(usage?.windows && usage.windows.length > 0 ? { usageWindows: usage.windows } : {}),
          ...(usage?.plan ? { usagePlan: usage.plan } : {}),
          ...(usage?.error ? { usageError: usage.error } : {}),
          ...(definition?.isLocal ? { isLocal: true } : {}),
        };

        return entry;
      });

      respond(true, { providers, updatedAt: now }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
