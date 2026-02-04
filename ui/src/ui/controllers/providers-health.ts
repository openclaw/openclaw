import type { GatewayBrowserClient } from "../gateway.ts";

export type UsageWindowEntry = {
  label: string;
  usedPercent: number;
  resetAt: number | null;
  resetRemainingMs: number | null;
};

export type ProviderHealthEntry = {
  id: string;
  name: string;
  detected: boolean;
  authSource: string | null;
  authMode: string;
  tokenValidity: string;
  tokenExpiresAt: number | null;
  tokenRemainingMs: number | null;
  healthStatus: string;
  inCooldown: boolean;
  cooldownRemainingMs: number;
  cooldownEndsAt: number | null;
  errorCount: number;
  disabledReason?: string;
  lastUsed: string | null;
  usageWindows: UsageWindowEntry[];
  usagePlan?: string;
  usageError?: string;
  isLocal: boolean;
};

export type ProvidersHealthHost = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  tab: string;
  providersHealthLoading: boolean;
  providersHealthError: string | null;
  providersHealthEntries: ProviderHealthEntry[];
  providersHealthUpdatedAt: number | null;
  providersHealthShowAll: boolean;
  providersHealthExpanded: string | null;
};

type RawEntry = {
  id: string;
  name: string;
  detected: boolean;
  authSource?: string;
  authMode?: string;
  tokenValidity?: string;
  tokenExpiresAt?: number;
  tokenRemainingMs?: number;
  healthStatus: string;
  inCooldown?: boolean;
  cooldownRemainingMs?: number;
  cooldownEndsAt?: number;
  errorCount?: number;
  disabledReason?: string;
  lastUsed?: string;
  usageWindows?: Array<{ label: string; usedPercent: number; resetAt?: number }>;
  usagePlan?: string;
  usageError?: string;
  isLocal?: boolean;
};

function mapEntry(raw: RawEntry): ProviderHealthEntry {
  const now = Date.now();
  return {
    id: raw.id,
    name: raw.name,
    detected: raw.detected,
    authSource: raw.authSource ?? null,
    authMode: raw.authMode ?? "unknown",
    tokenValidity: raw.tokenValidity ?? "unknown",
    tokenExpiresAt: raw.tokenExpiresAt ?? null,
    tokenRemainingMs: raw.tokenRemainingMs ?? null,
    healthStatus: raw.healthStatus,
    inCooldown: raw.inCooldown ?? false,
    cooldownRemainingMs: raw.cooldownRemainingMs ?? 0,
    cooldownEndsAt: raw.cooldownEndsAt ?? null,
    errorCount: raw.errorCount ?? 0,
    disabledReason: raw.disabledReason,
    lastUsed: raw.lastUsed ?? null,
    usageWindows: (raw.usageWindows ?? []).map((w) => ({
      label: w.label,
      usedPercent: w.usedPercent,
      resetAt: w.resetAt ?? null,
      resetRemainingMs: w.resetAt ? Math.max(0, w.resetAt - now) : null,
    })),
    usagePlan: raw.usagePlan,
    usageError: raw.usageError,
    isLocal: raw.isLocal ?? false,
  };
}

export async function loadProvidersHealth(host: ProvidersHealthHost): Promise<void> {
  if (!host.client || !host.connected) {
    return;
  }
  if (host.providersHealthLoading) {
    return;
  }
  host.providersHealthLoading = true;
  host.providersHealthError = null;
  try {
    const res = await host.client.request("providers.health", {
      all: host.providersHealthShowAll,
      includeUsage: true,
    });
    const data = res as { providers?: RawEntry[]; updatedAt?: number } | undefined;
    if (data && Array.isArray(data.providers)) {
      host.providersHealthEntries = data.providers.map(mapEntry);
      host.providersHealthUpdatedAt = typeof data.updatedAt === "number" ? data.updatedAt : null;
    }
  } catch (err) {
    host.providersHealthError = String(err);
  } finally {
    host.providersHealthLoading = false;
  }
}

// --- Polling (30s RPC refresh) ---

let pollInterval: ReturnType<typeof setInterval> | null = null;

export function startProvidersPolling(host: ProvidersHealthHost): void {
  stopProvidersPolling();
  void loadProvidersHealth(host);
  pollInterval = setInterval(() => {
    if (host.tab !== "providers") {
      return;
    }
    void loadProvidersHealth(host);
  }, 30_000);
}

export function stopProvidersPolling(): void {
  if (pollInterval != null) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

// --- Countdown (1s client-side timer decrement) ---

let countdownInterval: ReturnType<typeof setInterval> | null = null;

export function startProvidersCountdown(host: ProvidersHealthHost): void {
  stopProvidersCountdown();
  countdownInterval = setInterval(() => {
    if (host.providersHealthEntries.length === 0) {
      return;
    }
    let changed = false;
    const next = host.providersHealthEntries.map((entry) => {
      let updated = false;
      let tokenRemainingMs = entry.tokenRemainingMs;
      let cooldownRemainingMs = entry.cooldownRemainingMs;
      let healthStatus = entry.healthStatus;

      if (tokenRemainingMs !== null && tokenRemainingMs > 0) {
        tokenRemainingMs = Math.max(0, tokenRemainingMs - 1000);
        updated = true;
        if (tokenRemainingMs === 0 && healthStatus !== "expired") {
          healthStatus = "expired";
        }
      }

      if (cooldownRemainingMs > 0) {
        cooldownRemainingMs = Math.max(0, cooldownRemainingMs - 1000);
        updated = true;
        if (cooldownRemainingMs === 0 && healthStatus === "cooldown") {
          healthStatus = "healthy";
        }
      }

      const usageWindows = entry.usageWindows.map((w) => {
        if (w.resetRemainingMs !== null && w.resetRemainingMs > 0) {
          updated = true;
          return { ...w, resetRemainingMs: Math.max(0, w.resetRemainingMs - 1000) };
        }
        return w;
      });

      if (updated) {
        changed = true;
        return {
          ...entry,
          tokenRemainingMs,
          cooldownRemainingMs,
          healthStatus,
          usageWindows,
        };
      }
      return entry;
    });

    if (changed) {
      host.providersHealthEntries = next;
    }
  }, 1000);
}

export function stopProvidersCountdown(): void {
  if (countdownInterval != null) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}
