/** Preflights local model-provider endpoints before scheduled cron runner startup. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isLocalProviderBaseUrl } from "../../agents/model-provider-local.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessageWithCode } from "../../infra/errors.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";

const PREFLIGHT_CACHE_TTL_MS = 5 * 60_000;
/** Shorter TTL for client-side timeout failures: a gateway event-loop stall can
 * cause the deadline to fire even when the provider is healthy.  Cache these
 * for only 30 s so the next scheduled run gets a fresh probe instead of being
 * skipped for the full 5-minute window. */
const PREFLIGHT_TIMEOUT_CACHE_TTL_MS = 30_000;
const PREFLIGHT_TIMEOUT_MS = 2_500;
const PREFLIGHT_RETRY_COUNT = 2;
const PREFLIGHT_RETRY_DELAY_MS = 400;
const MAX_PREFLIGHT_ERROR_CAUSE_DEPTH = 8;
const MAX_PREFLIGHT_ERROR_CHARS = 1_000;

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
    };

type CachedEndpointPreflightResult = {
  checkedAtMs: number;
  /** True when the cached failure was a pure client-side timeout (vs a connect
   * error or an HTTP error from the provider).  Timeout entries expire sooner
   * so that a transient gateway event-loop stall does not skip runs for 5 min. */
  isTimeout?: boolean;
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

function readErrorProperty(error: unknown, key: "cause" | "code" | "message" | "name"): unknown {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) {
    return undefined;
  }
  try {
    return (error as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function collectPreflightErrorCauseChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (
    current !== undefined &&
    current !== null &&
    chain.length < MAX_PREFLIGHT_ERROR_CAUSE_DEPTH &&
    !seen.has(current)
  ) {
    seen.add(current);
    chain.push(current);
    current = readErrorProperty(current, "cause");
  }
  return chain;
}

function isPreflightTimeout(error: unknown): boolean {
  // fetchWithSsrFGuard propagates only its owned deadline as TimeoutError.
  return collectPreflightErrorCauseChain(error).some(
    (candidate) => readErrorProperty(candidate, "name") === "TimeoutError",
  );
}

function formatPreflightError(error: unknown): string {
  const causeDetails = formatErrorMessageWithCode(error);
  const classified = isPreflightTimeout(error)
    ? `Local provider preflight exceeded its configured ${PREFLIGHT_TIMEOUT_MS}ms deadline | ${causeDetails}`
    : causeDetails;
  return classified.length <= MAX_PREFLIGHT_ERROR_CHARS
    ? classified
    : `${truncateUtf16Safe(classified, MAX_PREFLIGHT_ERROR_CHARS - 1)}…`;
}

function formatUnavailableReason(params: {
  provider: string;
  model: string;
  baseUrl: string;
  error: unknown;
}): string {
  return [
    `This automation uses ${params.provider}/${params.model} but the local provider preflight failed at ${params.baseUrl}.`,
    `The candidate is unavailable for this run; OpenClaw will retry its provider preflight on a later scheduled run.`,
    `Last error: ${formatPreflightError(params.error)}`,
  ].join(" ");
}

function buildUnavailableResult(params: {
  provider: string;
  model: string;
  baseUrl: string;
  error: unknown;
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
    }),
  };
}

async function probeLocalProviderEndpointOnce(params: {
  api: PreflightApi;
  baseUrl: string;
}): Promise<void> {
  const { response, release } = await fetchWithSsrFGuard({
    url: buildProbeUrl(params.api, params.baseUrl),
    init: { method: "GET" },
    policy: buildLocalProviderSsrFPolicy(params.baseUrl),
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
    auditContext: "cron-model-provider-preflight",
  });
  try {
    // Any HTTP response means the local endpoint is alive. Auth/model errors
    // still belong to the normal model runner where fallback and diagnostics
    // have the full provider context.
    void response.status;
  } finally {
    // Captured responses can tee their body, so awaiting branch cancellation
    // would hang the cron probe; start cancellation before closing the agent.
    if (!response.bodyUsed) {
      void response.body?.cancel().catch(() => undefined);
    }
    await release();
  }
}

/** Probes the endpoint up to PREFLIGHT_RETRY_COUNT+1 times.
 *
 * A single client-side TimeoutError can be caused by a momentary gateway
 * event-loop stall rather than an unreachable provider.  One immediate retry
 * confirms the failure before caching it so a transient stall does not skip
 * every cron run scheduled in the next 5 minutes.
 */
async function probeLocalProviderEndpoint(params: {
  api: PreflightApi;
  baseUrl: string;
}): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= PREFLIGHT_RETRY_COUNT; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, PREFLIGHT_RETRY_DELAY_MS));
    }
    try {
      await probeLocalProviderEndpointOnce(params);
      return;
    } catch (error) {
      lastError = error;
      // Only retry on client-side timeouts; hard connect errors are not
      // transient and retrying them wastes cron startup time.
      if (!isPreflightTimeout(error)) {
        break;
      }
    }
  }
  throw lastError;
}

/** Checks local model-provider reachability before a scheduled cron run starts. */
export async function preflightCronModelProvider(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  nowMs?: number;
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

  const nowMs = params.nowMs ?? Date.now();
  const cacheKey = `${api}\0${baseUrl}`;
  const cached = preflightCache.get(cacheKey);
  if (cached) {
    // Cache by endpoint, not model: this probe only verifies local server
    // reachability, while model availability is handled by the runner.
    // Timeout-caused failures use a shorter TTL so a transient gateway
    // event-loop stall does not suppress runs for the full 5-minute window.
    const ttlMs = cached.isTimeout ? PREFLIGHT_TIMEOUT_CACHE_TTL_MS : PREFLIGHT_CACHE_TTL_MS;
    if (nowMs - cached.checkedAtMs < ttlMs) {
      if (cached.result.status === "available") {
        return { status: "available" };
      }
      return buildUnavailableResult({
        provider: params.provider,
        model: params.model,
        baseUrl,
        error: cached.result.error,
      });
    }
  }

  let result: EndpointPreflightResult;
  let resultIsTimeout = false;
  try {
    await probeLocalProviderEndpoint({ api, baseUrl });
    result = { status: "available" };
  } catch (error) {
    result = { status: "unavailable", error };
    resultIsTimeout = isPreflightTimeout(error);
  }
  preflightCache.set(cacheKey, { checkedAtMs: nowMs, result, isTimeout: resultIsTimeout });
  if (result.status === "available") {
    return { status: "available" };
  }
  return buildUnavailableResult({
    provider: params.provider,
    model: params.model,
    baseUrl,
    error: result.error,
  });
}

/** Clears the local-provider preflight cache for deterministic tests. */
export function resetCronModelProviderPreflightCacheForTest(): void {
  preflightCache.clear();
}
