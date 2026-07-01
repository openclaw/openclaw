/** Preflights local model-provider endpoints before scheduled cron runner startup. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";

const PREFLIGHT_CACHE_TTL_MS = 5 * 60_000;
const PREFLIGHT_TIMEOUT_MS = 2_500;
const PREFLIGHT_MAX_ATTEMPTS = 1;
const PREFLIGHT_RETRY_DELAY_MS = 0;

type PreflightApi = "ollama" | "openai-completions";

/** Local provider reachability result used to skip cron runs before runner startup. */
export type CronModelProviderPreflightResult =
  | { status: "available" }
  | {
      status: "unavailable";
      reason: string;
      provider: string;
      model: string;
      baseUrl: string;
      retryAfterMs: number;
    };

type EndpointPreflightResult =
  | { status: "available" }
  | {
      status: "unavailable";
      error: unknown;
      attempts: number;
    };

type CachedEndpointPreflightResult = {
  checkedAtMs: number;
  result: EndpointPreflightResult;
};

const preflightCache = new Map<string, CachedEndpointPreflightResult>();

function resolveProviderConfig(
  cfg: OpenClawConfig,
  provider: string,
): ModelProviderConfig | undefined {
  const providers = cfg.models?.providers;
  if (!providers) {
    return undefined;
  }
  const direct = providers[provider];
  if (direct) {
    return direct;
  }
  const normalized = normalizeProviderId(provider);
  return Object.entries(providers).find(([key]) => normalizeProviderId(key) === normalized)?.[1];
}

function normalizeBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed ? trimmed : undefined;
}

function normalizeProbeApi(providerConfig: ModelProviderConfig): PreflightApi | undefined {
  const api = normalizeLowercaseStringOrEmpty(providerConfig.api);
  return api === "ollama" || api === "openai-completions" ? api : undefined;
}

function isPrivateIpv4Host(host: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return false;
  }
  const octets = host.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = octets;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isLocalProviderBaseUrl(baseUrl: string): boolean {
  try {
    let host = normalizeLowercaseStringOrEmpty(new URL(baseUrl).hostname);
    if (host.startsWith("[") && host.endsWith("]")) {
      host = host.slice(1, -1);
    }
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host === "::ffff:7f00:1" ||
      host === "::ffff:127.0.0.1" ||
      host.endsWith(".local") ||
      isPrivateIpv4Host(host)
    );
  } catch {
    return false;
  }
}

function buildProbeUrl(api: PreflightApi, baseUrl: string): string {
  if (api === "ollama") {
    return `${baseUrl}/api/tags`;
  }
  return `${baseUrl}/models`;
}

function buildLocalProviderSsrFPolicy(baseUrl: string): SsrFPolicy | undefined {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return {
      // Local-provider probes intentionally allow private hosts, but only the
      // exact hostname from the configured provider base URL.
      hostnameAllowlist: [parsed.hostname],
      allowPrivateNetwork: true,
    };
  } catch {
    return undefined;
  }
}

function formatUnavailableReason(params: {
  provider: string;
  model: string;
  baseUrl: string;
  error: unknown;
  attempts: number;
}): string {
  return [
    `Agent cron job uses ${params.provider}/${params.model} but the local provider endpoint is not reachable at ${params.baseUrl}.`,
    `Skipping this cron run after ${params.attempts} preflight attempt${params.attempts === 1 ? "" : "s"}; OpenClaw will retry the provider preflight on a later scheduled run.`,
    `Last error: ${String(params.error)}`,
  ].join(" ");
}

function buildUnavailableResult(params: {
  provider: string;
  model: string;
  baseUrl: string;
  error: unknown;
  attempts: number;
}): CronModelProviderPreflightResult {
  return {
    status: "unavailable",
    provider: params.provider,
    model: params.model,
    baseUrl: params.baseUrl,
    retryAfterMs: PREFLIGHT_CACHE_TTL_MS,
    reason: formatUnavailableReason({
      provider: params.provider,
      model: params.model,
      baseUrl: params.baseUrl,
      error: params.error,
      attempts: params.attempts,
    }),
  };
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return fallback;
  }
  return value;
}

function sleepMs(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function resolveRemainingBudgetMs(deadlineMs: number | undefined): number | undefined {
  return deadlineMs === undefined ? undefined : Math.max(0, deadlineMs - Date.now());
}

async function probeLocalProviderEndpoint(params: {
  api: PreflightApi;
  baseUrl: string;
  timeoutMs: number;
}): Promise<void> {
  const { response, release } = await fetchWithSsrFGuard({
    url: buildProbeUrl(params.api, params.baseUrl),
    init: { method: "GET" },
    policy: buildLocalProviderSsrFPolicy(params.baseUrl),
    timeoutMs: params.timeoutMs,
    auditContext: "cron-model-provider-preflight",
  });
  try {
    // Any HTTP response means the local endpoint is alive. Auth/model errors
    // still belong to the normal model runner where fallback and diagnostics
    // have the full provider context.
    void response.status;
  } finally {
    await release();
  }
}

/** Checks local model-provider reachability before a scheduled cron run starts. */
export async function preflightCronModelProvider(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  nowMs?: number;
  deadlineMs?: number;
}): Promise<CronModelProviderPreflightResult> {
  const providerConfig = resolveProviderConfig(params.cfg, params.provider);
  if (!providerConfig) {
    return { status: "available" };
  }
  const baseUrl = normalizeBaseUrl(providerConfig.baseUrl);
  const api = normalizeProbeApi(providerConfig);
  if (!baseUrl || !api || !isLocalProviderBaseUrl(baseUrl)) {
    // Remote/cloud providers should fail in the model runner, not in this cron
    // reachability preflight.
    return { status: "available" };
  }
  const preflightConfig = params.cfg.cron?.modelPreflight;
  const timeoutMs = normalizePositiveInteger(preflightConfig?.timeoutMs, PREFLIGHT_TIMEOUT_MS);
  const maxAttempts = normalizePositiveInteger(
    preflightConfig?.maxAttempts,
    PREFLIGHT_MAX_ATTEMPTS,
  );
  const retryDelayMs = normalizeNonNegativeInteger(
    preflightConfig?.retryDelayMs,
    PREFLIGHT_RETRY_DELAY_MS,
  );

  const nowMs = params.nowMs ?? Date.now();
  const cacheKey = `${api}\0${baseUrl}`;
  const cached = preflightCache.get(cacheKey);
  if (cached && nowMs - cached.checkedAtMs < PREFLIGHT_CACHE_TTL_MS) {
    // Cache by endpoint, not model: this probe only verifies local server
    // reachability, while model availability is handled by the runner.
    if (cached.result.status === "available") {
      return { status: "available" };
    }
    return buildUnavailableResult({
      provider: params.provider,
      model: params.model,
      baseUrl,
      error: cached.result.error,
      attempts: cached.result.attempts,
    });
  }

  let lastError: unknown;
  let attempts = 0;
  let budgetExhausted = false;
  let cacheableFailure = true;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remainingBudgetMs = resolveRemainingBudgetMs(params.deadlineMs);
    if (remainingBudgetMs !== undefined && remainingBudgetMs <= 0) {
      budgetExhausted = true;
      lastError = new Error("cron model preflight chain budget exhausted");
      break;
    }
    attempts = attempt;
    const probeTimeoutMs =
      remainingBudgetMs === undefined ? timeoutMs : Math.min(timeoutMs, remainingBudgetMs);
    try {
      await probeLocalProviderEndpoint({
        api,
        baseUrl,
        timeoutMs: probeTimeoutMs,
      });
      const result: EndpointPreflightResult = { status: "available" };
      preflightCache.set(cacheKey, { checkedAtMs: nowMs, result });
      return { status: "available" };
    } catch (error) {
      lastError = error;
      // A deadline-clamped probe did not receive the configured health-check
      // window, so its failure must not poison the endpoint cache.
      if (probeTimeoutMs < timeoutMs) {
        cacheableFailure = false;
      }
      if (attempt < maxAttempts) {
        const remainingDelayBudgetMs = resolveRemainingBudgetMs(params.deadlineMs);
        if (remainingDelayBudgetMs !== undefined && remainingDelayBudgetMs <= 0) {
          budgetExhausted = true;
          lastError = new Error(
            `cron model preflight chain budget exhausted after ${attempts} attempt${attempts === 1 ? "" : "s"}`,
          );
          break;
        }
        await sleepMs(
          remainingDelayBudgetMs === undefined
            ? retryDelayMs
            : Math.min(retryDelayMs, remainingDelayBudgetMs),
        );
      }
    }
  }
  const result: EndpointPreflightResult = {
    status: "unavailable",
    error: lastError ?? new Error("cron model preflight chain budget exhausted"),
    attempts,
  };
  if (!budgetExhausted && cacheableFailure) {
    preflightCache.set(cacheKey, { checkedAtMs: nowMs, result });
  }
  return buildUnavailableResult({
    provider: params.provider,
    model: params.model,
    baseUrl,
    error: result.error,
    attempts: result.attempts,
  });
}

/** Clears the local-provider preflight cache for deterministic tests. */
export function resetCronModelProviderPreflightCacheForTest(): void {
  preflightCache.clear();
}
