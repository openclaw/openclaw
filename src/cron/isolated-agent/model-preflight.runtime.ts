import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isNonSecretApiKeyMarker } from "../../agents/model-auth-markers.js";
import {
  resolveProviderRequestHeaders,
  sanitizeConfiguredProviderRequest,
} from "../../agents/provider-request-config.js";
/** Preflights local model-provider endpoints before scheduled cron runner startup. */
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";
import { logDebug } from "../../logger.js";
import { resolveApiKeyForProvider } from "../../plugin-sdk/provider-auth-runtime.js";

const PREFLIGHT_CACHE_TTL_MS = 5 * 60_000;
const PREFLIGHT_TIMEOUT_MS = 2_500;

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
}): string {
  return [
    `Agent cron job uses ${params.provider}/${params.model} but the local provider endpoint is not reachable at ${params.baseUrl}.`,
    `Skipping this cron run; OpenClaw will retry the provider preflight on a later scheduled run.`,
    `Last error: ${formatErrorMessage(params.error)}`,
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

async function probeLocalProviderEndpoint(params: {
  api: PreflightApi;
  baseUrl: string;
  headers?: Record<string, string>;
}): Promise<void> {
  const { response, release } = await fetchWithSsrFGuard({
    url: buildProbeUrl(params.api, params.baseUrl),
    init: {
      method: "GET",
      ...(params.headers && Object.keys(params.headers).length > 0
        ? { headers: params.headers }
        : {}),
    },
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
    await release();
  }
}

/** Checks local model-provider reachability before a scheduled cron run starts. */
export async function preflightCronModelProvider(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  agentDir?: string;
  workspaceDir?: string;
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

  // Auth resolution for preflight probe via shared resolveProviderRequestHeaders
  const requestOverrides = sanitizeConfiguredProviderRequest(providerConfig.request);
  let headers: Record<string, string> | undefined;

  const headerModeConfigured = providerConfig?.request?.auth?.mode === "header";
  let headerModeWithEmptyFields = false;
  if (headerModeConfigured) {
    const headerAuth = providerConfig?.request?.auth;
    if (headerAuth?.mode === "header") {
      headerModeWithEmptyFields =
        !headerAuth.headerName?.trim() ||
        typeof headerAuth.value !== "string" ||
        !headerAuth.value.trim();
    }
  }

  // 1. Check request.auth config override via resolveProviderRequestHeaders
  if (requestOverrides?.auth) {
    headers = resolveProviderRequestHeaders({
      provider: params.provider,
      api,
      baseUrl,
      request: requestOverrides,
    });
  }

  // Debug log for misconfigured header mode (headerName or value is empty)
  if (headerModeWithEmptyFields) {
    logDebug(
      `[preflight] request.auth.mode is "header" but headerName or value is empty for provider ${params.provider}; skipping auth`,
    );
  }

  // 2. Fall through to resolveApiKeyForProvider (full credential chain, handles SecretRef/profile/env/markers)
  // Skip when mode is "header" — custom headers already handle auth, no Bearer needed
  if (!headers && !headerModeConfigured) {
    try {
      const resolved = await resolveApiKeyForProvider({
        provider: params.provider,
        cfg: params.cfg,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
      });
      if (
        resolved.apiKey &&
        resolved.mode !== "oauth" &&
        !isNonSecretApiKeyMarker(resolved.apiKey)
      ) {
        headers = resolveProviderRequestHeaders({
          provider: params.provider,
          api,
          baseUrl,
          request: { auth: { mode: "authorization-bearer", token: resolved.apiKey } },
        });
      }
    } catch (err) {
      logDebug(
        `[preflight] resolveApiKeyForProvider failed: ${String(err)} (non-fatal for preflight)`,
      );
    }
  }
  let result: EndpointPreflightResult;
  try {
    await probeLocalProviderEndpoint({
      api,
      baseUrl,
      headers,
    });
    result = { status: "available" };
  } catch (error) {
    result = { status: "unavailable", error: formatErrorMessage(error) };
  }
  preflightCache.set(cacheKey, { checkedAtMs: nowMs, result });
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
