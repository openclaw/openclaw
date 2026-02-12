import type { GatewayBrowserClient } from "../gateway.ts";

export type ClosestUsageWindow = {
  label: string;
  usedPercent: number;
  resetAt: number | null;
  resetRemainingMs: number | null;
};

export type ModelsAvailabilityState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  modelsAvailabilityLoading: boolean;
  modelsAvailabilityError: string | null;
  detectedProviders: Set<string>;
  unavailableProviders: Set<string>;
  cooldownModels: Set<string>;
};

type RawProvidersHealth = {
  providers?: Array<{
    id?: string;
    detected?: boolean;
    healthStatus?: string;
    disabledReason?: string;
  }>;
};

type RawCooldowns = {
  cooldowns?: Array<{ key?: string }>;
};

function isProviderUnavailable(healthStatus: string, detected: boolean): boolean {
  if (!detected) {
    return true;
  }
  // Treat "warning" as usable. Everything else is considered unavailable for UI selection.
  return ["missing", "disabled", "expired", "cooldown"].includes(healthStatus);
}

// Note: closest usage windows are computed from usage.status (same source as /usage),
// not providers.health.

export async function loadModelsAvailability(state: ModelsAvailabilityState): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.modelsAvailabilityLoading) {
    return;
  }
  state.modelsAvailabilityLoading = true;
  state.modelsAvailabilityError = null;
  try {
    const [healthRes, cooldownRes] = await Promise.all([
      state.client.request<RawProvidersHealth>("providers.health", {
        all: true,
        // Usage windows are fetched via usage.status so the composer bars match /usage exactly.
        includeUsage: false,
      }),
      state.client.request<RawCooldowns>("models.cooldowns", {}).catch(() => ({ cooldowns: [] })),
    ]);

    const detectedProviders = new Set<string>();
    const unavailableProviders = new Set<string>();
    for (const p of healthRes.providers ?? []) {
      const id = typeof p?.id === "string" ? p.id.trim().toLowerCase() : "";
      if (!id) {
        continue;
      }
      const detected = Boolean(p.detected);
      if (detected) {
        detectedProviders.add(id);
      }
      const healthStatus =
        typeof p.healthStatus === "string" ? p.healthStatus.trim().toLowerCase() : "unknown";
      const disabledReason = typeof p.disabledReason === "string" ? p.disabledReason.trim() : "";
      if (disabledReason) {
        unavailableProviders.add(id);
      } else if (isProviderUnavailable(healthStatus, detected)) {
        unavailableProviders.add(id);
      }
    }

    const cooldownModels = new Set<string>();
    for (const c of cooldownRes.cooldowns ?? []) {
      const key = typeof c?.key === "string" ? c.key.trim().toLowerCase() : "";
      if (key) {
        cooldownModels.add(key);
      }
    }

    state.detectedProviders = detectedProviders;
    state.unavailableProviders = unavailableProviders;
    state.cooldownModels = cooldownModels;
  } catch (err) {
    state.modelsAvailabilityError = String(err);
  } finally {
    state.modelsAvailabilityLoading = false;
  }
}

// --- Reactive polling for cooldownModels ---

let availabilityPollInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start polling models availability (including cooldownModels) every 15 seconds.
 * This ensures cooldownModels updates reactively as rate limits expire during a session.
 */
export function startModelsAvailabilityPolling(state: ModelsAvailabilityState): void {
  stopModelsAvailabilityPolling();

  // Initial load
  void loadModelsAvailability(state);

  // Poll every 15 seconds (same interval as usage polling)
  availabilityPollInterval = setInterval(() => {
    if (!state.connected) {
      return;
    }
    void loadModelsAvailability(state);
  }, 15_000);
}

/**
 * Stop polling models availability.
 */
export function stopModelsAvailabilityPolling(): void {
  if (availabilityPollInterval != null) {
    clearInterval(availabilityPollInterval);
    availabilityPollInterval = null;
  }
}
