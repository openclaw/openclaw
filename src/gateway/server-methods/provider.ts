import { loadConfig } from "../../config/config.js";
import type { GatewayRequestHandlers } from "./types.js";

// Types for provider usage responses
export type ProviderUsageEntry = {
  provider: string;
  displayName: string;
  /** Credits consumed (OpenRouter convention: USD dollar-denominated) */
  creditsUsed?: number;
  /** Total credit limit (null = unlimited or unknown) */
  creditsLimit?: number | null;
  /** Credits remaining */
  creditsRemaining?: number | null;
  /** Token / request usage counters where available */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    requests?: number;
    /** Cost in USD */
    cost?: number;
  };
  /** Quota / rate-limit info */
  quota?: {
    limit?: number;
    used?: number;
    remaining?: number;
    resetAt?: number;
    period?: string;
  };
  error?: string;
};

export type ProviderUsageResult = {
  updatedAt: number;
  providers: ProviderUsageEntry[];
};

const TIMEOUT_MS = 10_000;

/** Race a promise against a timeout, returning the fallback if time expires. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Anthropic organization usage API.
 * Endpoint: GET https://api.anthropic.com/v1/organization/usage
 * Auth: x-api-key header (admin API key required)
 *
 * curl example:
 *   curl -H "x-api-key: $ANTHROPIC_API_KEY" \
 *        -H "anthropic-version: 2023-06-01" \
 *        https://api.anthropic.com/v1/organization/usage
 */
async function fetchAnthropicUsage(apiKey: string): Promise<ProviderUsageEntry> {
  // Organization usage API requires an admin key (sk-ant-admin-...).
  // Standard OAuth tokens (sk-ant-oat01-...) and regular API keys don't have
  // access to this endpoint. Return a clear message rather than a 404/403.
  if (!apiKey.startsWith("sk-ant-admin")) {
    return {
      provider: "anthropic",
      displayName: "Anthropic",
      error: "Admin key required for usage stats — generate one at console.anthropic.com",
    };
  }
  try {
    const res = await fetch("https://api.anthropic.com/v1/organization/usage", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      let errMsg: string | undefined;
      try {
        const body = (await res.json()) as { error?: { message?: string } } | null;
        errMsg = body?.error?.message ?? undefined;
      } catch {
        // ignore parse errors
      }
      return {
        provider: "anthropic",
        displayName: "Anthropic",
        error: errMsg ? `HTTP ${res.status}: ${errMsg}` : `HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as Record<string, unknown>;
    return {
      provider: "anthropic",
      displayName: "Anthropic",
      usage: {
        inputTokens: typeof data.input_tokens === "number" ? data.input_tokens : undefined,
        outputTokens: typeof data.output_tokens === "number" ? data.output_tokens : undefined,
        totalTokens: typeof data.total_tokens === "number" ? data.total_tokens : undefined,
      },
    };
  } catch (err) {
    return {
      provider: "anthropic",
      displayName: "Anthropic",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * OpenRouter key info / usage API.
 * Endpoint: GET https://openrouter.ai/api/v1/auth/key
 * Auth: Authorization: Bearer <key>
 *
 * Returns credits used, credit limit, and rate-limit info.
 *
 * curl example:
 *   curl -H "Authorization: Bearer $OPENROUTER_API_KEY" \
 *        https://openrouter.ai/api/v1/auth/key
 */
async function fetchOpenRouterUsage(apiKey: string): Promise<ProviderUsageEntry> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      return {
        provider: "openrouter",
        displayName: "OpenRouter",
        error: `HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as {
      data?: {
        usage?: number;
        limit?: number | null;
        limit_remaining?: number | null;
        is_free_tier?: boolean;
        rate_limit?: {
          requests: number;
          interval: string;
        };
      };
    };
    const d = data.data;
    return {
      provider: "openrouter",
      displayName: "OpenRouter",
      creditsUsed: d?.usage,
      creditsLimit: d?.limit ?? null,
      creditsRemaining: d?.limit_remaining ?? null,
      quota: d?.rate_limit
        ? {
            limit: d.rate_limit.requests,
            period: d.rate_limit.interval,
          }
        : undefined,
    };
  } catch (err) {
    return {
      provider: "openrouter",
      displayName: "OpenRouter",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Moonshot AI (Kimi) balance endpoint.
 * Endpoint: GET https://api.moonshot.cn/v1/users/me/balance
 * Auth: Authorization: Bearer <key>
 *
 * curl example:
 *   curl -H "Authorization: Bearer $MOONSHOT_API_KEY" \
 *        https://api.moonshot.cn/v1/users/me/balance
 */
async function fetchMoonshotUsage(apiKey: string): Promise<ProviderUsageEntry> {
  try {
    const res = await fetch("https://api.moonshot.ai/v1/users/me/balance", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      return {
        provider: "moonshot",
        displayName: "Moonshot",
        error: `HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as {
      data?: {
        available_balance?: number;
        voucher_balance?: number;
        cash_balance?: number;
      };
    };
    const d = data.data;
    return {
      provider: "moonshot",
      displayName: "Moonshot",
      creditsRemaining: d?.available_balance,
      usage: {},
    };
  } catch (err) {
    return {
      provider: "moonshot",
      displayName: "Moonshot",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * HuggingFace billing overview (best-effort; requires PRO/Enterprise account).
 * Endpoint: GET https://huggingface.co/api/billing/overview
 * Auth: Authorization: Bearer <token>
 *
 * curl example:
 *   curl -H "Authorization: Bearer $HUGGINGFACE_API_KEY" \
 *        https://huggingface.co/api/billing/overview
 */
async function fetchHuggingFaceUsage(apiKey: string): Promise<ProviderUsageEntry> {
  try {
    const res = await fetch("https://huggingface.co/api/billing/overview", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      return {
        provider: "huggingface",
        displayName: "HuggingFace",
        error: `HTTP ${res.status} (billing API may require PRO account)`,
      };
    }
    const data = (await res.json()) as Record<string, unknown>;
    return {
      provider: "huggingface",
      displayName: "HuggingFace",
      usage: {
        cost: typeof data.currentMonthAmount === "number" ? data.currentMonthAmount : undefined,
      },
    };
  } catch (err) {
    return {
      provider: "huggingface",
      displayName: "HuggingFace",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export const providerHandlers: GatewayRequestHandlers = {
  /**
   * Fetch usage/quota from configured AI provider APIs.
   * Resolves API keys from config (models.providers.*.apiKey) with env-var fallbacks.
   * Only fetches providers for which a key is available.
   *
   * Supported: anthropic, openrouter, moonshot, huggingface
   *
   * curl example:
   *   curl -s -X POST http://localhost:18789 \
   *     -H 'Content-Type: application/json' \
   *     -d '{"type":"req","id":"4","method":"provider.usage","params":{}}'
   *
   * Environment variable fallbacks:
   *   ANTHROPIC_API_KEY, OPENROUTER_API_KEY, MOONSHOT_API_KEY, HUGGINGFACE_API_KEY
   */
  "provider.usage": async ({ respond }) => {
    const config = loadConfig();
    const providers = config.models?.providers ?? {};

    // Resolve keys: prefer config, fall back to env vars
    const resolveKey = (configKey: string, envVar: string): string | null => {
      const fromConfig =
        typeof providers[configKey]?.apiKey === "string" ? providers[configKey].apiKey.trim() : "";
      if (fromConfig) {
        return fromConfig;
      }
      const fromEnv = (process.env[envVar] ?? "").trim();
      return fromEnv || null;
    };

    const anthropicKey = resolveKey("anthropic", "ANTHROPIC_API_KEY");
    const openrouterKey = resolveKey("openrouter", "OPENROUTER_API_KEY");
    const moonshotKey = resolveKey("moonshot", "MOONSHOT_API_KEY");
    const huggingfaceKey = resolveKey("huggingface", "HUGGINGFACE_API_KEY");

    const tasks: Array<Promise<ProviderUsageEntry>> = [];

    if (anthropicKey) {
      tasks.push(
        withTimeout(fetchAnthropicUsage(anthropicKey), TIMEOUT_MS, {
          provider: "anthropic",
          displayName: "Anthropic",
          error: "Timeout",
        }),
      );
    }
    if (openrouterKey) {
      tasks.push(
        withTimeout(fetchOpenRouterUsage(openrouterKey), TIMEOUT_MS, {
          provider: "openrouter",
          displayName: "OpenRouter",
          error: "Timeout",
        }),
      );
    }
    if (moonshotKey) {
      tasks.push(
        withTimeout(fetchMoonshotUsage(moonshotKey), TIMEOUT_MS, {
          provider: "moonshot",
          displayName: "Moonshot",
          error: "Timeout",
        }),
      );
    }
    if (huggingfaceKey) {
      tasks.push(
        withTimeout(fetchHuggingFaceUsage(huggingfaceKey), TIMEOUT_MS, {
          provider: "huggingface",
          displayName: "HuggingFace",
          error: "Timeout",
        }),
      );
    }

    const providerResults = await Promise.all(tasks);
    const result: ProviderUsageResult = {
      updatedAt: Date.now(),
      providers: providerResults,
    };

    respond(true, result, undefined);
  },
};
