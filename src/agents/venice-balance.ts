import type { OpenClawConfig } from "../config/config.js";
import { resolveFetch } from "../infra/fetch.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import {
  ensureAuthProfileStore,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";
import { getCustomProviderApiKey, resolveEnvApiKey } from "./model-auth.js";
import { VENICE_BASE_URL } from "./venice-models.js";

export const VENICE_LOW_BALANCE_DEFAULT_USD = 0.05;
const VENICE_BALANCE_CACHE_MS = 30_000;
const VENICE_BALANCE_TIMEOUT_MS = 4_000;
const VENICE_RATE_LIMITS_PATH = "/api_keys/rate_limits";

type VeniceBalanceSnapshot = {
  usdBalance?: number;
  diemBalance?: number;
  fetchedAt: number;
  error?: string;
};

type VeniceBalanceCacheEntry = {
  expiresAt: number;
  value: VeniceBalanceSnapshot;
};

const balanceCacheByKey = new Map<string, VeniceBalanceCacheEntry>();
const inFlightByKey = new Map<string, Promise<VeniceBalanceSnapshot>>();

function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function extractBalances(payload: unknown): { usdBalance?: number; diemBalance?: number } {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== "object") {
    return {};
  }
  const balances = (data as { balances?: unknown }).balances;
  if (!balances || typeof balances !== "object") {
    return {};
  }
  const rawUsd = (balances as Record<string, unknown>).USD;
  const rawDiem = (balances as Record<string, unknown>).DIEM;
  return {
    usdBalance: parseFiniteNumber(rawUsd),
    diemBalance: parseFiniteNumber(rawDiem),
  };
}

async function resolveVeniceApiKey(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
}): Promise<string | undefined> {
  const envKey = resolveEnvApiKey("venice")?.apiKey;
  if (envKey) {
    return envKey;
  }
  const customKey = getCustomProviderApiKey(params.cfg, "venice");
  if (customKey) {
    return customKey;
  }

  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const profileIds = resolveAuthProfileOrder({
    cfg: params.cfg,
    store,
    provider: "venice",
  });
  for (const profileId of profileIds) {
    try {
      const resolved = await resolveApiKeyForProfile({
        cfg: params.cfg,
        store,
        profileId,
        agentDir: params.agentDir,
      });
      const key = normalizeOptionalSecretInput(resolved?.apiKey);
      if (key) {
        return key;
      }
    } catch {
      // ignore and continue
    }
  }
  return undefined;
}

async function fetchVeniceBalanceSnapshot(params: {
  apiKey: string;
  now: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<VeniceBalanceSnapshot> {
  const fetchFn = resolveFetch(params.fetchImpl);
  if (!fetchFn) {
    return {
      fetchedAt: params.now,
      error: "fetch is not available",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const response = await fetchFn(`${VENICE_BASE_URL}${VENICE_RATE_LIMITS_PATH}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        fetchedAt: params.now,
        error: `HTTP ${response.status}`,
      };
    }
    const payload = (await response.json()) as unknown;
    const balances = extractBalances(payload);
    return {
      fetchedAt: params.now,
      usdBalance: balances.usdBalance,
      diemBalance: balances.diemBalance,
      ...(balances.usdBalance === undefined ? { error: "USD balance unavailable" } : {}),
    };
  } catch (error) {
    return {
      fetchedAt: params.now,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function shouldSkipVeniceForLowBalance(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
  thresholdUsd?: number;
  now?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ skip: boolean; thresholdUsd: number; snapshot: VeniceBalanceSnapshot | null }> {
  const thresholdUsd =
    params.thresholdUsd ??
    params.cfg?.auth?.cooldowns?.veniceMinUsdBalance ??
    VENICE_LOW_BALANCE_DEFAULT_USD;
  if (!Number.isFinite(thresholdUsd) || thresholdUsd <= 0) {
    return {
      skip: false,
      thresholdUsd,
      snapshot: null,
    };
  }

  const apiKey = await resolveVeniceApiKey({
    cfg: params.cfg,
    agentDir: params.agentDir,
  });
  if (!apiKey) {
    return {
      skip: false,
      thresholdUsd,
      snapshot: null,
    };
  }

  const now = params.now ?? Date.now();
  const cached = balanceCacheByKey.get(apiKey);
  if (cached && cached.expiresAt > now) {
    return {
      skip: (cached.value.usdBalance ?? Number.POSITIVE_INFINITY) < thresholdUsd,
      thresholdUsd,
      snapshot: cached.value,
    };
  }

  const inFlight = inFlightByKey.get(apiKey);
  if (inFlight) {
    const snapshot = await inFlight;
    return {
      skip: (snapshot.usdBalance ?? Number.POSITIVE_INFINITY) < thresholdUsd,
      thresholdUsd,
      snapshot,
    };
  }

  const nextFetch = fetchVeniceBalanceSnapshot({
    apiKey,
    now,
    timeoutMs: VENICE_BALANCE_TIMEOUT_MS,
    fetchImpl: params.fetchImpl,
  }).finally(() => {
    inFlightByKey.delete(apiKey);
  });

  inFlightByKey.set(apiKey, nextFetch);
  const snapshot = await nextFetch;
  balanceCacheByKey.set(apiKey, {
    expiresAt: now + VENICE_BALANCE_CACHE_MS,
    value: snapshot,
  });
  return {
    skip: (snapshot.usdBalance ?? Number.POSITIVE_INFINITY) < thresholdUsd,
    thresholdUsd,
    snapshot,
  };
}

/** @internal – exposed for unit tests only */
export const _veniceBalanceInternals = {
  clearCache() {
    balanceCacheByKey.clear();
    inFlightByKey.clear();
  },
  extractBalances,
};
