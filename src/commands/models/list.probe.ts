import crypto from "node:crypto";
import fs from "node:fs/promises";
import { resolveOpenClawAgentDir } from "../../agents/agent-paths.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  type AuthProfileCredential,
  type AuthProfileEligibilityReasonCode,
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveApiKeyForProfile,
  resolveAuthProfileDisplayLabel,
  resolveAuthProfileEligibility,
  resolveAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import { describeFailoverError } from "../../agents/failover-error.js";
import { isNonSecretApiKeyMarker } from "../../agents/model-auth-markers.js";
import { getCustomProviderApiKey, resolveEnvApiKey } from "../../agents/model-auth.js";
import { loadModelCatalog } from "../../agents/model-catalog.js";
import {
  findNormalizedProviderValue,
  normalizeProviderId,
  parseModelRef,
} from "../../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveSessionTranscriptPath,
  resolveSessionTranscriptsDirForAgent,
} from "../../config/sessions/paths.js";
import { coerceSecretRef, normalizeSecretInputString } from "../../config/types.secrets.js";
import { type SecretRefResolveCache, resolveSecretRefString } from "../../secrets/resolve.js";
import { redactSecrets } from "../status-all/format.js";
import type { RateLimitInfo } from "./list.types.js";
import { DEFAULT_PROVIDER, formatMs } from "./shared.js";

const PROBE_PROMPT = "Reply with OK. Do not use tools.";

export type AuthProbeStatus =
  | "ok"
  | "auth"
  | "rate_limit"
  | "billing"
  | "timeout"
  | "format"
  | "unknown"
  | "no_model";

export type AuthProbeReasonCode =
  | "excluded_by_auth_order"
  | "missing_credential"
  | "expired"
  | "invalid_expires"
  | "unresolved_ref"
  | "ineligible_profile"
  | "no_model";

export type AuthProbeResult = {
  provider: string;
  model?: string;
  profileId?: string;
  label: string;
  source: "profile" | "env" | "models.json";
  mode?: string;
  status: AuthProbeStatus;
  reasonCode?: AuthProbeReasonCode;
  error?: string;
  latencyMs?: number;
  rateLimit?: RateLimitInfo;
};

type AuthProbeTarget = {
  provider: string;
  model?: { provider: string; model: string } | null;
  profileId?: string;
  label: string;
  source: "profile" | "env" | "models.json";
  mode?: string;
};

export type AuthProbeSummary = {
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  totalTargets: number;
  options: {
    provider?: string;
    profileIds?: string[];
    timeoutMs: number;
    concurrency: number;
    maxTokens: number;
  };
  results: AuthProbeResult[];
};

export type AuthProbeOptions = {
  provider?: string;
  profileIds?: string[];
  timeoutMs: number;
  concurrency: number;
  maxTokens: number;
  /** When true, make an additional lightweight API call to capture rate-limit headers. */
  rateLimits?: boolean;
};

export function mapFailoverReasonToProbeStatus(reason?: string | null): AuthProbeStatus {
  if (!reason) {
    return "unknown";
  }
  if (reason === "auth" || reason === "auth_permanent") {
    // Keep probe output backward-compatible: permanent auth failures still
    // surface in the auth bucket instead of showing as unknown.
    return "auth";
  }
  if (reason === "rate_limit" || reason === "overloaded") {
    return "rate_limit";
  }
  if (reason === "billing") {
    return "billing";
  }
  if (reason === "timeout") {
    return "timeout";
  }
  if (reason === "format") {
    return "format";
  }
  return "unknown";
}

function buildCandidateMap(modelCandidates: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const raw of modelCandidates) {
    const parsed = parseModelRef(String(raw ?? ""), DEFAULT_PROVIDER);
    if (!parsed) {
      continue;
    }
    const list = map.get(parsed.provider) ?? [];
    if (!list.includes(parsed.model)) {
      list.push(parsed.model);
    }
    map.set(parsed.provider, list);
  }
  return map;
}

function selectProbeModel(params: {
  provider: string;
  candidates: Map<string, string[]>;
  catalog: Array<{ provider: string; id: string }>;
}): { provider: string; model: string } | null {
  const { provider, candidates, catalog } = params;
  const direct = candidates.get(provider);
  if (direct && direct.length > 0) {
    return { provider, model: direct[0] };
  }
  const fromCatalog = catalog.find((entry) => entry.provider === provider);
  if (fromCatalog) {
    return { provider: fromCatalog.provider, model: fromCatalog.id };
  }
  return null;
}

function mapEligibilityReasonToProbeReasonCode(
  reasonCode: AuthProfileEligibilityReasonCode,
): AuthProbeReasonCode {
  if (reasonCode === "missing_credential") {
    return "missing_credential";
  }
  if (reasonCode === "expired") {
    return "expired";
  }
  if (reasonCode === "invalid_expires") {
    return "invalid_expires";
  }
  if (reasonCode === "unresolved_ref") {
    return "unresolved_ref";
  }
  return "ineligible_profile";
}

function formatMissingCredentialProbeError(reasonCode: AuthProbeReasonCode): string {
  const legacyLine = "Auth profile credentials are missing or expired.";
  if (reasonCode === "expired") {
    return `${legacyLine}\n↳ Auth reason [expired]: token credentials are expired.`;
  }
  if (reasonCode === "invalid_expires") {
    return `${legacyLine}\n↳ Auth reason [invalid_expires]: token expires must be a positive Unix ms timestamp.`;
  }
  if (reasonCode === "missing_credential") {
    return `${legacyLine}\n↳ Auth reason [missing_credential]: no inline credential or SecretRef is configured.`;
  }
  if (reasonCode === "unresolved_ref") {
    return `${legacyLine}\n↳ Auth reason [unresolved_ref]: configured SecretRef could not be resolved.`;
  }
  return `${legacyLine}\n↳ Auth reason [ineligible_profile]: profile is incompatible with provider config.`;
}

function resolveProbeSecretRef(profile: AuthProfileCredential, cfg: OpenClawConfig) {
  const defaults = cfg.secrets?.defaults;
  if (profile.type === "api_key") {
    if (normalizeSecretInputString(profile.key) !== undefined) {
      return null;
    }
    return coerceSecretRef(profile.keyRef, defaults);
  }
  if (profile.type === "token") {
    if (normalizeSecretInputString(profile.token) !== undefined) {
      return null;
    }
    return coerceSecretRef(profile.tokenRef, defaults);
  }
  return null;
}

function formatUnresolvedRefProbeError(refLabel: string): string {
  const legacyLine = "Auth profile credentials are missing or expired.";
  return `${legacyLine}\n↳ Auth reason [unresolved_ref]: could not resolve SecretRef "${refLabel}".`;
}

async function maybeResolveUnresolvedRefIssue(params: {
  cfg: OpenClawConfig;
  profile?: AuthProfileCredential;
  cache: SecretRefResolveCache;
}): Promise<{ reasonCode: "unresolved_ref"; error: string } | null> {
  if (!params.profile) {
    return null;
  }
  const ref = resolveProbeSecretRef(params.profile, params.cfg);
  if (!ref) {
    return null;
  }
  try {
    await resolveSecretRefString(ref, {
      config: params.cfg,
      env: process.env,
      cache: params.cache,
    });
    return null;
  } catch {
    return {
      reasonCode: "unresolved_ref",
      error: formatUnresolvedRefProbeError(`${ref.source}:${ref.provider}:${ref.id}`),
    };
  }
}

export async function buildProbeTargets(params: {
  cfg: OpenClawConfig;
  providers: string[];
  modelCandidates: string[];
  options: AuthProbeOptions;
}): Promise<{ targets: AuthProbeTarget[]; results: AuthProbeResult[] }> {
  const { cfg, providers, modelCandidates, options } = params;
  const store = ensureAuthProfileStore();
  const providerFilter = options.provider?.trim();
  const providerFilterKey = providerFilter ? normalizeProviderId(providerFilter) : null;
  const profileFilter = new Set((options.profileIds ?? []).map((id) => id.trim()).filter(Boolean));
  const refResolveCache: SecretRefResolveCache = {};
  const catalog = await loadModelCatalog({ config: cfg });
  const candidates = buildCandidateMap(modelCandidates);
  const targets: AuthProbeTarget[] = [];
  const results: AuthProbeResult[] = [];

  for (const provider of providers) {
    const providerKey = normalizeProviderId(provider);
    if (providerFilterKey && providerKey !== providerFilterKey) {
      continue;
    }

    const model = selectProbeModel({
      provider: providerKey,
      candidates,
      catalog,
    });

    const profileIds = listProfilesForProvider(store, providerKey);
    const explicitOrder = (() => {
      return (
        findNormalizedProviderValue(store.order, providerKey) ??
        findNormalizedProviderValue(cfg?.auth?.order, providerKey)
      );
    })();
    const allowedProfiles =
      explicitOrder && explicitOrder.length > 0
        ? new Set(resolveAuthProfileOrder({ cfg, store, provider: providerKey }))
        : null;
    const filteredProfiles = profileFilter.size
      ? profileIds.filter((id) => profileFilter.has(id))
      : profileIds;

    if (filteredProfiles.length > 0) {
      for (const profileId of filteredProfiles) {
        const profile = store.profiles[profileId];
        const mode = profile?.type;
        const label = resolveAuthProfileDisplayLabel({ cfg, store, profileId });
        if (explicitOrder && !explicitOrder.includes(profileId)) {
          results.push({
            provider: providerKey,
            profileId,
            model: model ? `${model.provider}/${model.model}` : undefined,
            label,
            source: "profile",
            mode,
            status: "unknown",
            reasonCode: "excluded_by_auth_order",
            error: "Excluded by auth.order for this provider.",
          });
          continue;
        }
        if (allowedProfiles && !allowedProfiles.has(profileId)) {
          const eligibility = resolveAuthProfileEligibility({
            cfg,
            store,
            provider: providerKey,
            profileId,
          });
          const reasonCode = mapEligibilityReasonToProbeReasonCode(eligibility.reasonCode);
          results.push({
            provider: providerKey,
            model: model ? `${model.provider}/${model.model}` : undefined,
            profileId,
            label,
            source: "profile",
            mode,
            status: "unknown",
            reasonCode,
            error: formatMissingCredentialProbeError(reasonCode),
          });
          continue;
        }
        const unresolvedRefIssue = await maybeResolveUnresolvedRefIssue({
          cfg,
          profile,
          cache: refResolveCache,
        });
        if (unresolvedRefIssue) {
          results.push({
            provider: providerKey,
            model: model ? `${model.provider}/${model.model}` : undefined,
            profileId,
            label,
            source: "profile",
            mode,
            status: "unknown",
            reasonCode: unresolvedRefIssue.reasonCode,
            error: unresolvedRefIssue.error,
          });
          continue;
        }
        if (!model) {
          results.push({
            provider: providerKey,
            model: undefined,
            profileId,
            label,
            source: "profile",
            mode,
            status: "no_model",
            reasonCode: "no_model",
            error: "No model available for probe",
          });
          continue;
        }
        targets.push({
          provider: providerKey,
          model,
          profileId,
          label,
          source: "profile",
          mode,
        });
      }
      continue;
    }

    if (profileFilter.size > 0) {
      continue;
    }

    const envKey = resolveEnvApiKey(providerKey);
    const customKey = getCustomProviderApiKey(cfg, providerKey);
    const hasUsableModelsJsonKey = Boolean(customKey && !isNonSecretApiKeyMarker(customKey));
    if (!envKey && !hasUsableModelsJsonKey) {
      continue;
    }

    const label = envKey ? "env" : "models.json";
    const source = envKey ? "env" : "models.json";
    const mode = envKey?.source.includes("OAUTH_TOKEN") ? "oauth" : "api_key";

    if (!model) {
      results.push({
        provider: providerKey,
        model: undefined,
        label,
        source,
        mode,
        status: "no_model",
        reasonCode: "no_model",
        error: "No model available for probe",
      });
      continue;
    }

    targets.push({
      provider: providerKey,
      model,
      label,
      source,
      mode,
    });
  }

  return { targets, results };
}

// ---------------------------------------------------------------------------
// Rate-limit header probing
// ---------------------------------------------------------------------------

/** Parse a numeric header value, returning `undefined` for missing/invalid values. */
export function parseIntHeader(value: string | null | undefined): number | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Extract standardised rate-limit headers from a `Headers`-like object. */
export function parseRateLimitHeaders(headers: {
  get(name: string): string | null;
}): RateLimitInfo | undefined {
  const info: RateLimitInfo = {
    remainingRequests: parseIntHeader(headers.get("x-ratelimit-remaining-requests")),
    limitRequests: parseIntHeader(headers.get("x-ratelimit-limit-requests")),
    remainingTokens: parseIntHeader(headers.get("x-ratelimit-remaining-tokens")),
    limitTokens: parseIntHeader(headers.get("x-ratelimit-limit-tokens")),
    resetRequests: headers.get("x-ratelimit-reset-requests") ?? undefined,
    resetTokens: headers.get("x-ratelimit-reset-tokens") ?? undefined,
  };

  // If every field is undefined, the provider didn't send rate-limit headers.
  const hasAny = Object.values(info).some((v) => v !== undefined);
  return hasAny ? info : undefined;
}

type ProviderEndpoint = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

/** Default base URLs for known providers. */
const DEFAULT_PROVIDER_BASE_URLS: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  xai: "https://api.x.ai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

/**
 * Build the cheapest possible request for a provider — max_tokens=1, single-char prompt.
 * Respects custom baseUrl from models.providers config when available.
 */
function buildProviderEndpoint(params: {
  provider: string;
  model: string;
  apiKey: string;
  customBaseUrl?: string;
}): ProviderEndpoint | null {
  const { provider, model, apiKey, customBaseUrl } = params;

  if (provider === "anthropic") {
    const raw = customBaseUrl?.replace(/\/+$/, "") ?? "https://api.anthropic.com";
    // Avoid path doubling when custom baseUrl already includes a version segment (e.g. /v1)
    const base = /\/v\d+$/.test(raw) ? raw : `${raw}/v1`;
    return {
      url: `${base}/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "." }],
      }),
    };
  }

  // OpenAI-compatible providers (OpenAI, Groq, xAI, Cerebras, Mistral, OpenRouter)
  const openAICompatible = ["openai", "groq", "xai", "cerebras", "mistral", "openrouter"];
  if (openAICompatible.includes(provider)) {
    const raw = customBaseUrl?.replace(/\/+$/, "") ?? DEFAULT_PROVIDER_BASE_URLS[provider] ?? null;
    if (!raw) {
      return null;
    }
    // Custom base URLs may or may not include the /chat/completions path segment;
    // we always append it since rate-limit headers come from completion endpoints.
    return {
      url: `${raw}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "." }],
      }),
    };
  }

  // Google — uses API key in query param, different request format.
  // Rate-limit headers may not follow the x-ratelimit-* convention.
  if (provider === "google") {
    const raw = customBaseUrl?.replace(/\/+$/, "") ?? "https://generativelanguage.googleapis.com";
    // Avoid path doubling when custom baseUrl already includes a version segment (e.g. /v1beta)
    const base = /\/v\d+(?:beta\d*|alpha\d*)?$/.test(raw) ? raw : `${raw}/v1beta`;
    return {
      url: `${base}/models/${model}:generateContent?key=${apiKey}`,
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "." }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
    };
  }

  return null;
}

/** Resolve the API key for a given probe target. */
async function resolveApiKeyForTarget(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  target: AuthProbeTarget;
}): Promise<string | null> {
  const { cfg, target } = params;
  if (target.profileId) {
    const store = ensureAuthProfileStore(params.agentDir);
    const result = await resolveApiKeyForProfile({
      cfg,
      store,
      profileId: target.profileId,
      agentDir: params.agentDir,
    });
    return result?.apiKey ?? null;
  }
  // Env-based or models.json-based key
  const envKey = resolveEnvApiKey(target.provider);
  if (envKey) {
    return envKey.apiKey;
  }
  const customKey = getCustomProviderApiKey(cfg, target.provider);
  if (customKey && !isNonSecretApiKeyMarker(customKey)) {
    return customKey;
  }
  return null;
}

/** Resolve custom base URL from models.providers config, if configured. */
function resolveCustomBaseUrl(cfg: OpenClawConfig, provider: string): string | undefined {
  const providers = cfg?.models?.providers ?? {};
  const providerConfig = (providers[provider] ?? providers[normalizeProviderId(provider)]) as
    | { baseUrl?: string }
    | undefined;
  return providerConfig?.baseUrl?.trim() || undefined;
}

/**
 * Make a lightweight direct HTTP call to capture rate-limit headers.
 * Only called after the main probe succeeds (status === "ok").
 */
async function probeRateLimits(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  target: AuthProbeTarget;
  timeoutMs: number;
}): Promise<RateLimitInfo | undefined> {
  const { cfg, target, timeoutMs } = params;
  if (!target.model) {
    return undefined;
  }

  const apiKey = await resolveApiKeyForTarget({
    cfg,
    agentDir: params.agentDir,
    target,
  });
  if (!apiKey) {
    return undefined;
  }

  const customBaseUrl = resolveCustomBaseUrl(cfg, target.model.provider);
  const endpoint = buildProviderEndpoint({
    provider: target.model.provider,
    model: target.model.model,
    apiKey,
    customBaseUrl,
  });
  if (!endpoint) {
    return undefined;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: endpoint.headers,
        body: endpoint.body,
        signal: controller.signal,
      });
      // We only need the headers — even a 429 or error response may include them.
      return parseRateLimitHeaders(response.headers);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Rate-limit probing is best-effort; never fail the overall probe.
    return undefined;
  }
}

async function probeTarget(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  sessionDir: string;
  target: AuthProbeTarget;
  timeoutMs: number;
  maxTokens: number;
  rateLimits?: boolean;
}): Promise<AuthProbeResult> {
  const { cfg, agentId, agentDir, workspaceDir, sessionDir, target, timeoutMs, maxTokens } = params;
  if (!target.model) {
    return {
      provider: target.provider,
      model: undefined,
      profileId: target.profileId,
      label: target.label,
      source: target.source,
      mode: target.mode,
      status: "no_model",
      reasonCode: "no_model",
      error: "No model available for probe",
    };
  }

  const sessionId = `probe-${target.provider}-${crypto.randomUUID()}`;
  const sessionFile = resolveSessionTranscriptPath(sessionId, agentId);
  await fs.mkdir(sessionDir, { recursive: true });

  const start = Date.now();
  try {
    await runEmbeddedPiAgent({
      sessionId,
      sessionFile,
      agentId,
      workspaceDir,
      agentDir,
      config: cfg,
      prompt: PROBE_PROMPT,
      provider: target.model.provider,
      model: target.model.model,
      authProfileId: target.profileId,
      authProfileIdSource: target.profileId ? "user" : undefined,
      timeoutMs,
      runId: `probe-${crypto.randomUUID()}`,
      lane: `auth-probe:${target.provider}:${target.profileId ?? target.source}`,
      thinkLevel: "off",
      reasoningLevel: "off",
      verboseLevel: "off",
      streamParams: { maxTokens },
    });
    const latencyMs = Date.now() - start;

    // Optionally make a separate lightweight call to capture rate-limit headers.
    let rateLimit: RateLimitInfo | undefined;
    if (params.rateLimits) {
      rateLimit = await probeRateLimits({ cfg, agentDir, target, timeoutMs });
    }

    return {
      provider: target.provider,
      model: `${target.model.provider}/${target.model.model}`,
      profileId: target.profileId,
      label: target.label,
      source: target.source,
      mode: target.mode,
      status: "ok",
      latencyMs,
      rateLimit,
    };
  } catch (err) {
    const described = describeFailoverError(err);
    return {
      provider: target.provider,
      model: `${target.model.provider}/${target.model.model}`,
      profileId: target.profileId,
      label: target.label,
      source: target.source,
      mode: target.mode,
      status: mapFailoverReasonToProbeStatus(described.reason),
      error: redactSecrets(described.message),
      latencyMs: Date.now() - start,
    };
  }
}

async function runTargetsWithConcurrency(params: {
  cfg: OpenClawConfig;
  targets: AuthProbeTarget[];
  timeoutMs: number;
  maxTokens: number;
  concurrency: number;
  rateLimits?: boolean;
  onProgress?: (update: { completed: number; total: number; label?: string }) => void;
}): Promise<AuthProbeResult[]> {
  const { cfg, targets, timeoutMs, maxTokens, onProgress } = params;
  const concurrency = Math.max(1, Math.min(targets.length || 1, params.concurrency));

  const agentId = resolveDefaultAgentId(cfg);
  const agentDir = resolveOpenClawAgentDir();
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId) ?? resolveDefaultAgentWorkspaceDir();
  const sessionDir = resolveSessionTranscriptsDirForAgent(agentId);

  await fs.mkdir(workspaceDir, { recursive: true });

  let completed = 0;
  const results: Array<AuthProbeResult | undefined> = Array.from({ length: targets.length });
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= targets.length) {
        return;
      }
      const target = targets[index];
      onProgress?.({
        completed,
        total: targets.length,
        label: `Probing ${target.provider}${target.profileId ? ` (${target.label})` : ""}`,
      });
      const result = await probeTarget({
        cfg,
        agentId,
        agentDir,
        workspaceDir,
        sessionDir,
        target,
        timeoutMs,
        maxTokens,
        rateLimits: params.rateLimits,
      });
      results[index] = result;
      completed += 1;
      onProgress?.({ completed, total: targets.length });
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return results.filter((entry): entry is AuthProbeResult => Boolean(entry));
}

export async function runAuthProbes(params: {
  cfg: OpenClawConfig;
  providers: string[];
  modelCandidates: string[];
  options: AuthProbeOptions;
  onProgress?: (update: { completed: number; total: number; label?: string }) => void;
}): Promise<AuthProbeSummary> {
  const startedAt = Date.now();
  const plan = await buildProbeTargets({
    cfg: params.cfg,
    providers: params.providers,
    modelCandidates: params.modelCandidates,
    options: params.options,
  });

  const totalTargets = plan.targets.length;
  params.onProgress?.({ completed: 0, total: totalTargets });

  const results = totalTargets
    ? await runTargetsWithConcurrency({
        cfg: params.cfg,
        targets: plan.targets,
        timeoutMs: params.options.timeoutMs,
        maxTokens: params.options.maxTokens,
        concurrency: params.options.concurrency,
        rateLimits: params.options.rateLimits,
        onProgress: params.onProgress,
      })
    : [];

  const finishedAt = Date.now();

  return {
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    totalTargets,
    options: params.options,
    results: [...plan.results, ...results],
  };
}

export function formatRateLimitShort(info?: RateLimitInfo | null): {
  rpm: string;
  tpm: string;
} {
  if (!info) {
    return { rpm: "-", tpm: "-" };
  }
  const rpm =
    info.remainingRequests != null && info.limitRequests != null
      ? `${info.remainingRequests}/${info.limitRequests}`
      : info.remainingRequests != null
        ? `${info.remainingRequests}`
        : info.limitRequests != null
          ? `-/${info.limitRequests}`
          : "-";
  const tpm =
    info.remainingTokens != null && info.limitTokens != null
      ? `${info.remainingTokens}/${info.limitTokens}`
      : info.remainingTokens != null
        ? `${info.remainingTokens}`
        : info.limitTokens != null
          ? `-/${info.limitTokens}`
          : "-";
  return { rpm, tpm };
}

export function formatProbeLatency(latencyMs?: number | null) {
  if (!latencyMs && latencyMs !== 0) {
    return "-";
  }
  return formatMs(latencyMs);
}

export function groupProbeResults(results: AuthProbeResult[]): Map<string, AuthProbeResult[]> {
  const map = new Map<string, AuthProbeResult[]>();
  for (const result of results) {
    const list = map.get(result.provider) ?? [];
    list.push(result);
    map.set(result.provider, list);
  }
  return map;
}

export function sortProbeResults(results: AuthProbeResult[]): AuthProbeResult[] {
  return results.slice().toSorted((a, b) => {
    const provider = a.provider.localeCompare(b.provider);
    if (provider !== 0) {
      return provider;
    }
    const aLabel = a.label || a.profileId || "";
    const bLabel = b.label || b.profileId || "";
    return aLabel.localeCompare(bLabel);
  });
}

export function describeProbeSummary(summary: AuthProbeSummary): string {
  if (summary.totalTargets === 0) {
    return "No probe targets.";
  }
  return `Probed ${summary.totalTargets} target${summary.totalTargets === 1 ? "" : "s"} in ${formatMs(summary.durationMs)}`;
}
