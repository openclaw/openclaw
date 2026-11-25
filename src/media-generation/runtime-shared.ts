import { clampTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  buildCapabilityProviderDefaultRefs,
  resolveCapabilityModelRefForProviders,
  type CapabilityModelRef as ParsedProviderModelRef,
  type CapabilityModelProviderCandidate,
} from "../../packages/media-generation-core/src/capability-model-ref.js";
import { parseGenerationModelRef } from "../../packages/media-generation-core/src/model-ref.js";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { describeFailoverError, isFailoverError } from "../agents/failover-error.js";
import type { FallbackAttempt } from "../agents/model-fallback.types.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.js";
import { formatErrorMessage, toErrorObject } from "../infra/errors.js";
import {
  isProviderApiKeyConfigured,
  isProviderApiKeyConfiguredAsync,
} from "../plugins/provider-auth-availability.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import { getProviderEnvVarsCore } from "../secrets/provider-env-vars.js";

function buildCapabilityCandidateFailure(
  candidate: ParsedProviderModelRef,
  error: unknown,
): FallbackAttempt {
  const described = isFailoverError(error) ? describeFailoverError(error) : undefined;
  return {
    provider: candidate.provider,
    model: candidate.model,
    error: described?.message ?? formatErrorMessage(error),
    reason: described?.reason,
    status: described?.status,
    code: described?.code,
  };
}

type PreparedMediaGenerationCandidate<TResult> =
  | string
  | ((attempts: FallbackAttempt[]) => Promise<TResult>);

/** Keeps provider lookup and capability preflight outside the generation fallback catch. */
export async function runMediaGenerationCandidates<TProvider extends object, TResult>(params: {
  request: {
    cfg: OpenClawConfig;
    agentDir?: string;
    modelOverride?: string;
    autoProviderFallback?: boolean;
  };
  capability: "image" | "music" | "video";
  listProviders: (cfg?: OpenClawConfig) => CapabilityProviderCandidate[];
  getProviderEnvVars?: typeof getProviderEnvVarsCore;
  getProvider: (providerId: string) => TProvider | undefined;
  prepareCandidate: (
    candidate: ParsedProviderModelRef,
    provider: TProvider,
  ) =>
    | PreparedMediaGenerationCandidate<TResult>
    | Promise<PreparedMediaGenerationCandidate<TResult>>;
  onFailure?: (attempt: FallbackAttempt) => void;
}): Promise<TResult> {
  const candidates = await resolveCapabilityModelCandidatesAsync({
    ...params.request,
    modelConfig: params.request.cfg.agents?.defaults?.mediaModels?.[params.capability],
    parseModelRef: parseGenerationModelRef,
    listProviders: params.listProviders,
  });
  if (candidates.length === 0) {
    throw new Error(
      buildNoCapabilityModelConfiguredMessage({
        capabilityLabel: `${params.capability}-generation`,
        modelConfigKey: `mediaModels.${params.capability}`,
        providers: params.listProviders(params.request.cfg),
        fallbackSampleRef:
          params.capability === "music" ? "google/lyria-3-clip-preview" : undefined,
        getProviderEnvVars: params.getProviderEnvVars,
      }),
    );
  }
  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;
  for (const candidate of candidates) {
    const provider = params.getProvider(candidate.provider);
    const preparation = provider
      ? params.prepareCandidate(candidate, provider)
      : `No ${params.capability}-generation provider registered for ${candidate.provider}`;
    // Image/music preflight is synchronous; only video's capability overlay yields.
    const prepared = preparation instanceof Promise ? await preparation : preparation;
    if (typeof prepared === "string") {
      const attempt =
        provider && params.capability !== "video"
          ? buildCapabilityCandidateFailure(candidate, prepared)
          : { provider: candidate.provider, model: candidate.model, error: prepared };
      attempts.push(attempt);
      lastError = new Error(prepared);
      if (!provider && params.capability === "image") {
        params.onFailure?.(attempt);
      }
      continue;
    }
    try {
      return await prepared(attempts);
    } catch (error) {
      lastError = error;
      const attempt = buildCapabilityCandidateFailure(candidate, error);
      attempts.push(attempt);
      params.onFailure?.(attempt);
    }
  }
  return throwCapabilityGenerationFailure({
    capabilityLabel: `${params.capability} generation`,
    attempts,
    lastError,
  });
}

/** Reject edit requests before provider I/O, including providers with incomplete limits. */
export function resolveReferenceImageCapabilityError(params: {
  candidateRef: string;
  inputImageCount: number;
  edit?: { enabled: boolean; maxInputImages?: number };
}): string | undefined {
  if (params.inputImageCount === 0) {
    return undefined;
  }
  if (!params.edit?.enabled) {
    return `${params.candidateRef} does not support reference-image edit inputs`;
  }
  const maxInputImages = params.edit.maxInputImages ?? 10;
  return params.inputImageCount > maxInputImages
    ? `${params.candidateRef} supports at most ${maxInputImages} reference image${maxInputImages === 1 ? "" : "s"}, ${params.inputImageCount} requested`
    : undefined;
}

function resolveMediaProviderDefaultTimeoutMs(timeoutMs: number | undefined): number | undefined {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? clampTimerTimeoutMs(timeoutMs)
    : undefined;
}

/** Resolves a request timeout, preferring per-request over provider defaults. */
export function resolveMediaProviderRequestTimeoutMs(params: {
  timeoutMs?: number;
  providerDefaultTimeoutMs?: number;
}): number | undefined {
  return (
    resolveMediaProviderDefaultTimeoutMs(params.timeoutMs) ??
    resolveMediaProviderDefaultTimeoutMs(params.providerDefaultTimeoutMs)
  );
}

type CapabilityProviderCandidate = CapabilityModelProviderCandidate & {
  /** @deprecated Implement isConfiguredAsync so credential reads use the worker. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
  isConfigured?: (ctx: { cfg?: OpenClawConfig; agentDir?: string }) => boolean;
  isConfiguredAsync?: (ctx: { cfg?: OpenClawConfig; agentDir?: string }) => Promise<boolean>;
};

function resolveCurrentDefaultProviderId(cfg?: OpenClawConfig): string {
  const trimmed = resolveAgentModelPrimaryValue(cfg?.agents?.defaults?.model);
  if (!trimmed) {
    return DEFAULT_PROVIDER;
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0) {
    return DEFAULT_PROVIDER;
  }
  const provider = normalizeOptionalString(trimmed.slice(0, slash));
  return provider || DEFAULT_PROVIDER;
}

type CapabilityFallbackParams = {
  cfg: OpenClawConfig;
  agentDir?: string;
  listProviders: (cfg?: OpenClawConfig) => CapabilityProviderCandidate[];
};

function buildAutoCapabilityFallbackRefs(
  params: CapabilityFallbackParams,
  configuredProviders: CapabilityProviderCandidate[],
): string[] {
  return buildCapabilityProviderDefaultRefs({
    providers: configuredProviders,
    preferredProvider: resolveCurrentDefaultProviderId(params.cfg),
  });
}

type CapabilityModelCandidatesParams = {
  cfg: OpenClawConfig;
  modelConfig: AgentModelConfig | undefined;
  modelOverride?: string;
  parseModelRef: (raw: string | undefined) => ParsedProviderModelRef | null;
  agentDir?: string;
  listProviders?: (cfg?: OpenClawConfig) => CapabilityProviderCandidate[];
  autoProviderFallback?: boolean;
};

function prepareCapabilityModelCandidates(params: CapabilityModelCandidatesParams): {
  candidates: ParsedProviderModelRef[];
  fallbackParams?: CapabilityFallbackParams;
  add: (raw: string, useProviderMetadata: boolean) => void;
} {
  const candidates: ParsedProviderModelRef[] = [];
  const seen = new Set<string>();
  let providers: CapabilityProviderCandidate[] | undefined;
  const getProviders = (): CapabilityProviderCandidate[] => {
    providers ??= params.listProviders?.(params.cfg) ?? [];
    return providers;
  };
  const resolveCandidate = (raw: string | undefined, useProviderMetadata: boolean) => {
    const trimmed = normalizeOptionalString(raw);
    if (!trimmed) {
      return null;
    }
    if (!useProviderMetadata) {
      return params.parseModelRef(raw);
    }
    return resolveCapabilityModelRefForProviders({
      raw: trimmed,
      providers: getProviders(),
      parseModelRef: params.parseModelRef,
    });
  };
  const add = (raw: string | undefined, useProviderMetadata: boolean) => {
    const candidate = resolveCandidate(raw, useProviderMetadata);
    if (!candidate) {
      return;
    }
    const key = `${candidate.provider}/${candidate.model}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(candidate);
  };

  const override = resolveCandidate(params.modelOverride, true);
  if (override) {
    // Explicit model overrides are authoritative and should not be expanded into
    // auto provider fallback candidates.
    return { candidates: [override], add };
  }
  if (normalizeOptionalString(params.modelOverride)) {
    throw new Error(
      `Unknown model override: ${params.modelOverride}. Use a provider/model reference or a model listed by a provider.`,
    );
  }

  // Cross-provider fallback is a fixed product policy; Doctor removes the retired opt-out.
  const autoProviderFallbackEnabled = params.autoProviderFallback ?? true;
  add(resolveAgentModelPrimaryValue(params.modelConfig), autoProviderFallbackEnabled);
  for (const fallback of resolveAgentModelFallbackValues(params.modelConfig)) {
    add(fallback, autoProviderFallbackEnabled);
  }
  return {
    candidates,
    add,
    fallbackParams:
      autoProviderFallbackEnabled && params.listProviders
        ? { cfg: params.cfg, agentDir: params.agentDir, listProviders: () => getProviders() }
        : undefined,
  };
}

/** @deprecated Use resolveCapabilityModelCandidatesAsync for worker-backed credential reads. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
export function resolveCapabilityModelCandidates(
  params: CapabilityModelCandidatesParams,
): ParsedProviderModelRef[] {
  warnPluginSdkDeprecation({
    family: "provider-selection",
    method: "resolveCapabilityModelCandidates",
    replacement: "await resolveCapabilityModelCandidatesAsync()",
  });
  const prepared = prepareCapabilityModelCandidates(params);
  const fallbackParams = prepared.fallbackParams;
  if (fallbackParams) {
    const configuredProviders: CapabilityProviderCandidate[] = [];
    for (const provider of fallbackParams.listProviders(params.cfg)) {
      if (!isAutoCapabilityFallbackCandidate(provider, configuredProviders)) {
        continue;
      }
      const configured = provider.isConfigured
        ? provider.isConfigured({ cfg: params.cfg, agentDir: params.agentDir })
        : isProviderApiKeyConfigured({
            provider: provider.id,
            cfg: params.cfg,
            agentDir: params.agentDir,
          });
      if (configured) {
        configuredProviders.push(provider);
      }
    }
    for (const ref of buildAutoCapabilityFallbackRefs(fallbackParams, configuredProviders)) {
      prepared.add(ref, false);
    }
  }
  return prepared.candidates;
}

function isAutoCapabilityFallbackCandidate(
  provider: CapabilityProviderCandidate,
  configuredProviders: CapabilityProviderCandidate[],
): boolean {
  const id = normalizeOptionalString(provider.id);
  return Boolean(
    id &&
    normalizeOptionalString(provider.defaultModel) &&
    !configuredProviders.some((configured) => normalizeOptionalString(configured.id) === id),
  );
}

export async function resolveCapabilityModelCandidatesAsync(
  params: CapabilityModelCandidatesParams,
): Promise<ParsedProviderModelRef[]> {
  const prepared = prepareCapabilityModelCandidates(params);
  const fallbackParams = prepared.fallbackParams;
  if (fallbackParams) {
    const configuredProviders: CapabilityProviderCandidate[] = [];
    for (const provider of fallbackParams.listProviders(params.cfg)) {
      if (!isAutoCapabilityFallbackCandidate(provider, configuredProviders)) {
        continue;
      }
      const ctx = { cfg: params.cfg, agentDir: params.agentDir };
      if (!provider.isConfiguredAsync && provider.isConfigured) {
        warnPluginSdkDeprecation({
          family: "provider-sync-configuration",
          method: "media provider isConfigured",
          replacement: "isConfiguredAsync",
        });
      }
      const configured = provider.isConfiguredAsync
        ? await provider.isConfiguredAsync(ctx)
        : provider.isConfigured
          ? provider.isConfigured(ctx)
          : await isProviderApiKeyConfiguredAsync({ provider: provider.id, ...ctx });
      if (configured) {
        configuredProviders.push(provider);
      }
    }
    for (const ref of buildAutoCapabilityFallbackRefs(fallbackParams, configuredProviders)) {
      prepared.add(ref, false);
    }
  }
  return prepared.candidates;
}

/** Throws a summarized error after all provider/model candidates fail. */
export function throwCapabilityGenerationFailure(params: {
  capabilityLabel: string;
  attempts: FallbackAttempt[];
  lastError: unknown;
}): never {
  if (params.attempts.length <= 1 && params.lastError) {
    throw toErrorObject(params.lastError, "Non-Error thrown");
  }
  const summary = formatCapabilityFailureAttempts(params.attempts);
  throw new Error(
    `All ${params.capabilityLabel} models failed (${params.attempts.length}): ${summary}`,
    {
      cause: params.lastError instanceof Error ? params.lastError : undefined,
    },
  );
}

function formatCapabilityFailureAttempts(attempts: FallbackAttempt[]): string {
  if (attempts.length === 0) {
    return "unknown";
  }
  const failures: string[] = [];
  const aborted: string[] = [];
  for (const attempt of attempts) {
    const ref = `${attempt.provider}/${attempt.model}`;
    const message = attempt.error.trim().toLowerCase();
    if (message.includes("operation was aborted") || message.includes("request was aborted")) {
      aborted.push(ref);
    } else {
      failures.push(`${ref}: ${attempt.error}`);
    }
  }
  if (aborted.length) {
    failures.push(
      `${aborted.length} fallback(s) aborted after the request was cancelled or timed out: ${aborted.join(", ")}`,
    );
  }
  return failures.join(" | ");
}

export function buildNoCapabilityModelConfiguredMessage(params: {
  capabilityLabel: string;
  modelConfigKey: string;
  providers: Array<{ id: string; defaultModel?: string | null }>;
  fallbackSampleRef?: string;
  getProviderEnvVars?: typeof getProviderEnvVarsCore;
}): string {
  const getProviderEnvVars = params.getProviderEnvVars ?? getProviderEnvVarsCore;
  const sampleModel = params.providers.find(
    (provider) =>
      normalizeOptionalString(provider.id) && normalizeOptionalString(provider.defaultModel),
  );
  const sampleRef = sampleModel
    ? `${sampleModel.id}/${sampleModel.defaultModel}`
    : (params.fallbackSampleRef ?? "<provider>/<model>");
  const authHints = params.providers
    .flatMap((provider) => {
      const envVars = getProviderEnvVars(provider.id);
      if (envVars.length === 0) {
        return [];
      }
      return [`${provider.id}: ${envVars.join(" / ")}`];
    })
    .slice(0, 3);
  return [
    `No ${params.capabilityLabel} model configured. Set agents.defaults.${params.modelConfigKey}.primary to a provider/model like "${sampleRef}".`,
    authHints.length > 0
      ? `If you want a specific provider, also configure that provider's auth/API key first (${authHints.join("; ")}).`
      : "If you want a specific provider, also configure that provider's auth/API key first.",
  ].join(" ");
}
