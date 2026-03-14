import {
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveApiKeyForProfile,
} from "../agents/auth-profiles.js";
import { isRecord } from "../utils.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import { resolveFetch } from "./fetch.js";
import { fetchJson, parseFiniteNumber } from "./provider-usage.fetch.shared.js";
import { DEFAULT_TIMEOUT_MS } from "./provider-usage.shared.js";

export type OpenRouterKeyUsage = {
  profileId: string;
  label?: string;
  isManagementKey: boolean;
  isProvisioningKey: boolean;
  limit: number | null;
  limitReset: string | null;
  limitRemaining: number | null;
  includeByokInLimit: boolean;
  usage: number;
  usageDaily: number;
  usageWeekly: number;
  usageMonthly: number;
  byokUsage: number;
  byokUsageDaily: number;
  byokUsageWeekly: number;
  byokUsageMonthly: number;
  isFreeTier: boolean;
  expiresAt: string | null;
};

export type OpenRouterMeteredUsage = {
  kind: "metered";
  displayName: "OpenRouter";
  status: "ok" | "error";
  account?: {
    totalCredits: number;
    totalUsage: number;
    remainingCredits: number;
    usedPercent: number;
  };
  keys: OpenRouterKeyUsage[];
  error?: string;
};

type OpenRouterTokenEntry = {
  profileId: string;
  token: string;
};

function parseStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseBoolean(value: unknown): boolean {
  return value === true;
}

function parseNumberOrZero(value: unknown): number {
  return parseFiniteNumber(value) ?? 0;
}

function parseNumberOrNull(value: unknown): number | null {
  const parsed = parseFiniteNumber(value);
  return parsed === undefined ? null : parsed;
}

function parseOpenRouterKeyData(
  data: Record<string, unknown>,
  profileId: string,
): OpenRouterKeyUsage {
  return {
    profileId,
    label: parseStringOrNull(data.label) ?? undefined,
    isManagementKey: parseBoolean(data.is_management_key),
    isProvisioningKey: parseBoolean(data.is_provisioning_key),
    limit: parseNumberOrNull(data.limit),
    limitReset: parseStringOrNull(data.limit_reset),
    limitRemaining: parseNumberOrNull(data.limit_remaining),
    includeByokInLimit: parseBoolean(data.include_byok_in_limit),
    usage: parseNumberOrZero(data.usage),
    usageDaily: parseNumberOrZero(data.usage_daily),
    usageWeekly: parseNumberOrZero(data.usage_weekly),
    usageMonthly: parseNumberOrZero(data.usage_monthly),
    byokUsage: parseNumberOrZero(data.byok_usage),
    byokUsageDaily: parseNumberOrZero(data.byok_usage_daily),
    byokUsageWeekly: parseNumberOrZero(data.byok_usage_weekly),
    byokUsageMonthly: parseNumberOrZero(data.byok_usage_monthly),
    isFreeTier: parseBoolean(data.is_free_tier),
    expiresAt: parseStringOrNull(data.expires_at),
  };
}

async function resolveOpenRouterTokens(agentDir?: string): Promise<OpenRouterTokenEntry[]> {
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });

  const profileIds = listProfilesForProvider(store, "openrouter");
  const out: OpenRouterTokenEntry[] = [];
  const seen = new Set<string>();

  for (const profileId of profileIds) {
    try {
      const resolved = await resolveApiKeyForProfile({
        cfg: undefined,
        store,
        profileId,
        agentDir,
      });
      const token = normalizeSecretInput(resolved?.apiKey);
      if (!token || seen.has(token)) {
        continue;
      }
      seen.add(token);
      out.push({ profileId, token });
    } catch {
      // ignore profile resolution failures
    }
  }

  const envToken = normalizeSecretInput(process.env.OPENROUTER_API_KEY);
  if (envToken && !seen.has(envToken)) {
    out.push({ profileId: "env:OPENROUTER_API_KEY", token: envToken });
  }

  return out;
}

async function fetchOpenRouterCredits(params: {
  token: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<{ totalCredits: number; totalUsage: number } | null> {
  const response = await fetchJson(
    "https://openrouter.ai/api/v1/credits",
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${params.token}`,
        "Content-Type": "application/json",
      },
    },
    params.timeoutMs,
    params.fetchFn,
  );

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json().catch(() => null)) as unknown;
  if (!isRecord(payload) || !isRecord(payload.data)) {
    return null;
  }

  const totalCredits = parseFiniteNumber(payload.data.total_credits);
  const totalUsage = parseFiniteNumber(payload.data.total_usage);
  if (totalCredits === undefined || totalUsage === undefined) {
    return null;
  }

  return {
    totalCredits,
    totalUsage,
  };
}

async function fetchOpenRouterKeyUsage(params: {
  token: string;
  profileId: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<OpenRouterKeyUsage | null> {
  const response = await fetchJson(
    "https://openrouter.ai/api/v1/auth/key",
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${params.token}`,
        "Content-Type": "application/json",
      },
    },
    params.timeoutMs,
    params.fetchFn,
  );

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json().catch(() => null)) as unknown;
  if (!isRecord(payload) || !isRecord(payload.data)) {
    return null;
  }

  return parseOpenRouterKeyData(payload.data, params.profileId);
}

export async function loadOpenRouterMeteredUsage(opts?: {
  agentDir?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): Promise<OpenRouterMeteredUsage | null> {
  const fetchFn = resolveFetch(opts?.fetch);
  if (!fetchFn) {
    return null;
  }

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tokenEntries = await resolveOpenRouterTokens(opts?.agentDir);
  if (tokenEntries.length === 0) {
    return null;
  }

  try {
    // Fetch credits only from first key; omit account data if multiple keys (ambiguous which account owns the totals)
    let credits: { totalCredits: number; totalUsage: number } | null = null;
    let creditsError: Error | null = null;

    if (tokenEntries.length === 1) {
      try {
        credits = await fetchOpenRouterCredits({
          token: tokenEntries[0].token,
          timeoutMs,
          fetchFn,
        });
      } catch (error) {
        creditsError = error instanceof Error ? error : new Error(String(error));
      }
    }

    // Fetch per-key usage concurrently with a small cap to avoid overwhelming the API
    const concurrency = 5;
    let keyIndex = 0;
    const keys: OpenRouterKeyUsage[] = [];
    const keyErrors: Error[] = [];

    const worker = async () => {
      while (keyIndex < tokenEntries.length) {
        const currentIndex = keyIndex++;
        const tokenEntry = tokenEntries[currentIndex];

        try {
          const keyUsage = await fetchOpenRouterKeyUsage({
            token: tokenEntry.token,
            profileId: tokenEntry.profileId,
            timeoutMs,
            fetchFn,
          });
          if (keyUsage) {
            keys.push(keyUsage);
          }
        } catch (error) {
          keyErrors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
    };

    const workerCount = Math.min(concurrency, tokenEntries.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    // Determine overall status: error if credentials failed or no keys fetched successfully
    let status: "ok" | "error" = "ok";
    let errorMessage: string | undefined;

    if (creditsError || keyErrors.length > 0) {
      if (keys.length === 0) {
        // All requests failed; report error
        status = "error";
        errorMessage = creditsError?.message ?? keyErrors[0]?.message ?? "OpenRouter API error";
      } else {
        // Some keys succeeded; report partial success but flag it
        status = creditsError ? "error" : "ok";
        if (creditsError && !errorMessage) {
          errorMessage = `Credits fetch failed: ${creditsError.message}`;
        }
      }
    }

    const account =
      credits && tokenEntries.length === 1
        ? {
            totalCredits: credits.totalCredits,
            totalUsage: credits.totalUsage,
            remainingCredits: credits.totalCredits - credits.totalUsage,
            usedPercent:
              credits.totalCredits > 0 ? (credits.totalUsage / credits.totalCredits) * 100 : 0,
          }
        : undefined;

    return {
      kind: "metered",
      displayName: "OpenRouter",
      status,
      account,
      keys,
      error: errorMessage,
    };
  } catch (error) {
    return {
      kind: "metered",
      displayName: "OpenRouter",
      status: "error",
      keys: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
