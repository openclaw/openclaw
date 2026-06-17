import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
/** Preflights local model-provider endpoints before scheduled cron runner startup. */
import { resolveDefaultAgentDir } from "../../agents/agent-scope-config.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";

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
    `Last error: ${String(params.error)}`,
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

async function resolveProbeApiKey(
  providerCfg: ModelProviderConfig | undefined,
  provider: string,
  cfg: OpenClawConfig,
): Promise<string | undefined> {
  // Resolve API key from the same source chain as normal inference calls.
  // Try multiple sources and return the first one found.

  // 1. Direct config apiKey field
  const configKey = providerCfg?.apiKey;
  if (configKey && typeof configKey === "string" && configKey.trim()) {
    return configKey.trim();
  }

  // 2. auth-profiles.json
  try {
    const agentDir = resolveDefaultAgentDir(cfg);
    const fs = await import("node:fs");
    const path = await import("node:path");
    const authPath = path.join(agentDir, "auth-profiles.json");
    if (fs.existsSync(authPath)) {
      const data = JSON.parse(fs.readFileSync(authPath, "utf8"));
      if (data?.profiles) {
        for (const [key, profile] of Object.entries(data.profiles)) {
          const p = profile as { provider?: string; key?: string };
          if ((key.startsWith(provider + ":") || p.provider === provider) && p.key) {
            return p.key;
          }
        }
      }
    }
  } catch {}

  // 3. Env var: LITELLM_API_KEY, VLLM_API_KEY, SGLANG_API_KEY, etc.
  const upperName = provider.toUpperCase().replace(/[^A-Z0-9_]/g, "");
  const directKey = process.env[upperName + "_API_KEY"];
  if (directKey?.trim()) {
    return directKey.trim();
  }

  return undefined;
}

async function probeLocalProviderEndpoint(params: {
  api: PreflightApi;
  baseUrl: string;
  apiKey?: string;
}): Promise<void> {
  const headers: Record<string, string> | undefined = params.apiKey
    ? { Authorization: `Bearer ${params.apiKey}` }
    : undefined;
  const { response, release } = await fetchWithSsrFGuard({
    url: buildProbeUrl(params.api, params.baseUrl),
    init: { method: "GET", ...(headers ? { headers } : {}) },
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

  let result: EndpointPreflightResult;
  try {
    const probeApiKey = await resolveProbeApiKey(providerConfig, params.provider, params.cfg);
    await probeLocalProviderEndpoint({
      api,
      baseUrl,
      apiKey: probeApiKey,
    });
    result = { status: "available" };
  } catch (error) {
    result = { status: "unavailable", error };
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
