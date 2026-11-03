/** Preflights local model-provider endpoints before scheduled cron runner startup. */
import { once } from "node:events";
import net from "node:net";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isLocalProviderBaseUrl } from "../../agents/model-provider-local.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessageWithCode } from "../../infra/errors.js";
import { isManagedProxyActive } from "../../infra/net/fetch-guard.js";
import { shouldUseEnvHttpProxyForUrl } from "../../infra/net/proxy-env.js";
import { resolvePinnedHostnameWithPolicy } from "../../infra/net/ssrf.js";
import { buildTimeoutAbortSignal } from "../../utils/fetch-timeout.js";

const PREFLIGHT_CACHE_TTL_MS = 5 * 60_000;
const PREFLIGHT_TIMEOUT_MS = 2_500;
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

function normalizeProbeApi(providerConfig: ModelProviderConfig): PreflightApi | undefined {
  const api = normalizeLowercaseStringOrEmpty(providerConfig.api);
  return api === "ollama" || api === "openai-completions" ? api : undefined;
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
  // The probe-owned deadline also survives inside an AbortError cause.
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
    reason: [
      `This automation uses ${params.provider}/${params.model} but the local provider preflight failed at ${params.baseUrl}.`,
      `Start the local provider or correct its configured endpoint; OpenClaw will retry its provider preflight on a later scheduled run.`,
      `Last error: ${formatPreflightError(params.error)}`,
    ].join(" "),
  };
}

async function probeLocalProviderEndpoint(baseUrl: string): Promise<void> {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported local provider protocol: ${url.protocol}`);
  }
  const { signal, cleanup } = buildTimeoutAbortSignal({
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
    operation: "cron-model-provider-preflight",
    url: baseUrl,
  });
  try {
    const pinned = await resolvePinnedHostnameWithPolicy(url.hostname, {
      policy: { hostnameAllowlist: [url.hostname], allowPrivateNetwork: true },
      signal,
    });
    const socket = net.connect({
      host: pinned.hostname,
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      lookup: pinned.lookup,
    });
    const closed = new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
    });
    try {
      // Reachability needs no HTTP request or credentials. TLS, auth, and model
      // errors belong to inference, which has the complete provider context.
      await once(socket, "connect", { signal });
    } finally {
      socket.destroy();
      await closed;
    }
  } finally {
    cleanup();
  }
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
  const baseUrl = normalizeOptionalString(providerConfig.baseUrl)?.replace(/\/+$/, "");
  const api = normalizeProbeApi(providerConfig);
  if (
    !baseUrl ||
    !api ||
    !isLocalProviderBaseUrl(baseUrl) ||
    (isManagedProxyActive() && shouldUseEnvHttpProxyForUrl(baseUrl))
  ) {
    // Inference owns remote and proxy-routed connectivity; a direct local
    // socket cannot establish whether a managed proxy can reach its target.
    return { status: "available" };
  }

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
    });
  }

  let result: EndpointPreflightResult;
  try {
    await probeLocalProviderEndpoint(baseUrl);
    result = { status: "available" };
  } catch (error) {
    result = { status: "unavailable", error };
  }
  if (result.status === "available" || !isPreflightTimeout(result.error)) {
    preflightCache.set(cacheKey, { checkedAtMs: nowMs, result });
  }
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
