import { clampTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  resolveCapabilityModelRefForProviders,
  type CapabilityModelRef as ParsedProviderModelRef,
  type CapabilityModelProviderCandidate,
} from "../../packages/media-generation-core/src/capability-model-ref.js";
import { parseGenerationModelRef } from "../../packages/media-generation-core/src/model-ref.js";
import type { MediaGenerationNormalizationMetadataInput } from "../../packages/media-generation-core/src/normalization.js";
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
import { isProviderApiKeyConfigured } from "../plugins/provider-auth-availability.js";
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
  const candidates = resolveCapabilityModelCandidates({
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
  isConfigured?: (ctx: { cfg?: OpenClawConfig; agentDir?: string }) => boolean;
};

type ParsedAspectRatio = {
  width: number;
  height: number;
  value: number;
};

type ParsedSize = {
  width: number;
  height: number;
  aspectRatio: number;
  area: number;
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

function resolveAutoCapabilityFallbackRefs(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  listProviders: (cfg?: OpenClawConfig) => CapabilityProviderCandidate[];
}): string[] {
  const providerDefaults = new Map<string, { ref: string; aliases: string[] }>();
  for (const provider of params.listProviders(params.cfg)) {
    const providerId = normalizeOptionalString(provider.id);
    const modelId = normalizeOptionalString(provider.defaultModel);
    if (
      !providerId ||
      !modelId ||
      providerDefaults.has(providerId) ||
      !(provider.isConfigured
        ? provider.isConfigured({ cfg: params.cfg, agentDir: params.agentDir })
        : isProviderApiKeyConfigured({
            provider: provider.id,
            cfg: params.cfg,
            agentDir: params.agentDir,
          }))
    ) {
      continue;
    }
    const aliases = (provider.aliases ?? []).flatMap((alias) => {
      const normalized = normalizeOptionalString(alias);
      return normalized ? [normalized] : [];
    });
    providerDefaults.set(providerId, { ref: `${providerId}/${modelId}`, aliases });
  }

  const defaultProvider = resolveCurrentDefaultProviderId(params.cfg);
  const providerIds = [...providerDefaults.keys()].toSorted();
  const matchesDefaultProvider = (providerId: string): boolean => {
    const entry = providerDefaults.get(providerId);
    return providerId === defaultProvider || (entry?.aliases ?? []).includes(defaultProvider);
  };
  const orderedProviders = [
    ...providerIds.filter(matchesDefaultProvider),
    ...providerIds.filter((providerId) => !matchesDefaultProvider(providerId)),
  ];
  // Keep the user's default text provider first when it also has media support;
  // then add the remaining configured media providers deterministically.
  return orderedProviders.flatMap((providerId) => {
    const entry = providerDefaults.get(providerId);
    return entry ? [entry.ref] : [];
  });
}

export function resolveCapabilityModelCandidates(params: {
  cfg: OpenClawConfig;
  modelConfig: AgentModelConfig | undefined;
  modelOverride?: string;
  parseModelRef: (raw: string | undefined) => ParsedProviderModelRef | null;
  agentDir?: string;
  listProviders?: (cfg?: OpenClawConfig) => CapabilityProviderCandidate[];
  autoProviderFallback?: boolean;
}): ParsedProviderModelRef[] {
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
    return [override];
  }

  // Cross-provider fallback is a fixed product policy; Doctor removes the retired opt-out.
  const autoProviderFallbackEnabled = params.autoProviderFallback ?? true;
  add(params.modelOverride, true);
  add(resolveAgentModelPrimaryValue(params.modelConfig), autoProviderFallbackEnabled);
  for (const fallback of resolveAgentModelFallbackValues(params.modelConfig)) {
    add(fallback, autoProviderFallbackEnabled);
  }
  if (autoProviderFallbackEnabled && params.listProviders) {
    for (const candidate of resolveAutoCapabilityFallbackRefs({
      cfg: params.cfg,
      agentDir: params.agentDir,
      listProviders: () => getProviders(),
    })) {
      add(candidate, false);
    }
  }
  return candidates;
}

function normalizeSupportedValues<TValue extends string>(values?: readonly TValue[]): TValue[] {
  return (values ?? []).filter((entry) => Boolean(normalizeOptionalString(entry)));
}

function selectClosestValue<T extends string>(
  values: readonly T[],
  score: (value: T) => { primary: number; secondary: number } | undefined,
): T | undefined {
  let best: { value: T; primary: number; secondary: number } | undefined;
  for (const value of values) {
    const next = score(value);
    if (
      next &&
      (!best ||
        (next.primary !== best.primary
          ? next.primary < best.primary
          : next.secondary !== best.secondary
            ? next.secondary < best.secondary
            : value.localeCompare(best.value) < 0))
    ) {
      best = { value, ...next };
    }
  }
  return best?.value;
}

function parsePositiveDimensionPair(
  raw: string | null | undefined,
  pattern: RegExp,
): { width: number; height: number } | null {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return null;
  }
  const match = pattern.exec(trimmed);
  if (!match) {
    return null;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

function parseAspectRatioValue(raw?: string | null): ParsedAspectRatio | null {
  const pair = parsePositiveDimensionPair(raw, /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (!pair) {
    return null;
  }
  return {
    width: pair.width,
    height: pair.height,
    value: pair.width / pair.height,
  };
}

function parseSizeValue(raw?: string | null): ParsedSize | null {
  const pair = parsePositiveDimensionPair(raw, /^(\d+)\s*x\s*(\d+)$/i);
  if (!pair) {
    return null;
  }
  if (!Number.isSafeInteger(pair.width) || !Number.isSafeInteger(pair.height)) {
    return null;
  }
  return {
    width: pair.width,
    height: pair.height,
    aspectRatio: pair.width / pair.height,
    area: pair.width * pair.height,
  };
}

function greatestCommonDivisor(a: number, b: number): number {
  let left = Math.abs(a);
  let right = Math.abs(b);
  while (right !== 0) {
    const next = left % right;
    left = right;
    right = next;
  }
  return left || 1;
}

/** Derives a reduced aspect ratio string from a WIDTHxHEIGHT size. */
function deriveAspectRatioFromSize(size?: string): string | undefined {
  const parsed = parseSizeValue(size);
  if (!parsed) {
    return undefined;
  }
  const divisor = greatestCommonDivisor(parsed.width, parsed.height);
  return `${parsed.width / divisor}:${parsed.height / divisor}`;
}

export function resolveClosestAspectRatio(params: {
  requestedAspectRatio?: string;
  requestedSize?: string;
  supportedAspectRatios?: readonly string[];
}): string | undefined {
  const supported = normalizeSupportedValues(params.supportedAspectRatios);
  if (supported.length === 0) {
    return params.requestedAspectRatio ?? deriveAspectRatioFromSize(params.requestedSize);
  }
  if (params.requestedAspectRatio && supported.includes(params.requestedAspectRatio)) {
    return params.requestedAspectRatio;
  }
  const requested =
    parseAspectRatioValue(params.requestedAspectRatio) ??
    parseAspectRatioValue(deriveAspectRatioFromSize(params.requestedSize));
  if (!requested) {
    return undefined;
  }

  return selectClosestValue(supported, (candidate) => {
    const parsed = parseAspectRatioValue(candidate);
    if (!parsed) {
      return undefined;
    }
    return {
      primary: Math.abs(Math.log(parsed.value / requested.value)),
      secondary: Math.abs(parsed.width * requested.height - requested.width * parsed.height),
    };
  });
}

/** Chooses the closest supported size by aspect ratio and area. */
export function resolveClosestSize(params: {
  requestedSize?: string;
  requestedAspectRatio?: string;
  supportedSizes?: readonly string[];
}): string | undefined {
  const supported = normalizeSupportedValues(params.supportedSizes);
  if (supported.length === 0) {
    return params.requestedSize;
  }
  if (params.requestedSize && supported.includes(params.requestedSize)) {
    return params.requestedSize;
  }
  const requested = parseSizeValue(params.requestedSize);
  const requestedAspectRatio = parseAspectRatioValue(params.requestedAspectRatio);
  if (!requested && !requestedAspectRatio) {
    return undefined;
  }

  return selectClosestValue(supported, (candidate) => {
    const parsed = parseSizeValue(candidate);
    if (!parsed) {
      return undefined;
    }
    return {
      primary: Math.abs(
        Math.log(parsed.aspectRatio / (requested?.aspectRatio ?? requestedAspectRatio!.value)),
      ),
      secondary: requested ? Math.abs(Math.log(parsed.area / requested.area)) : parsed.area,
    };
  });
}

/** Chooses the closest supported resolution within the same numeric unit. */
export function resolveClosestResolution<TResolution extends string>(params: {
  requestedResolution?: TResolution;
  supportedResolutions?: readonly TResolution[];
}): TResolution | undefined {
  const supported = normalizeSupportedValues(params.supportedResolutions);
  if (supported.length === 0) {
    return params.requestedResolution;
  }
  if (params.requestedResolution && supported.includes(params.requestedResolution)) {
    return params.requestedResolution;
  }
  const requestedNumeric = parseResolutionRank(params.requestedResolution);
  if (!requestedNumeric) {
    return undefined;
  }
  return selectClosestValue(supported, (candidate) => {
    const candidateNumeric = parseResolutionRank(candidate);
    if (!candidateNumeric || candidateNumeric.unit !== requestedNumeric.unit) {
      return undefined;
    }
    return {
      primary: Math.abs(candidateNumeric.value - requestedNumeric.value),
      secondary: candidateNumeric.value < requestedNumeric.value ? 1 : 0,
    };
  });
}

function parseResolutionRank(
  resolution: string | undefined,
): { value: number; unit: "K" | "P" } | undefined {
  const match = resolution?.trim().match(/^(\d+(?:\.\d+)?)([kp])$/iu);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const unit = match[2]?.toUpperCase() === "K" ? "K" : "P";
  return {
    value: unit === "K" ? value * 1000 : value,
    unit,
  };
}

/** Rounds duration and clamps it to a provider maximum when supplied. */
export function normalizeDurationToClosestMax(
  durationSeconds?: number,
  maxDurationSeconds?: number,
) {
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds)) {
    return undefined;
  }
  const rounded = Math.max(1, Math.round(durationSeconds));
  if (
    typeof maxDurationSeconds !== "number" ||
    !Number.isFinite(maxDurationSeconds) ||
    maxDurationSeconds <= 0
  ) {
    return rounded;
  }
  return Math.min(rounded, Math.max(1, Math.round(maxDurationSeconds)));
}

export function buildMediaGenerationNormalizationMetadata(params: {
  normalization?: MediaGenerationNormalizationMetadataInput;
  requestedSizeForDerivedAspectRatio?: string;
  includeSupportedDurationSeconds?: boolean;
}): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  const { normalization } = params;
  if (normalization?.size?.requested !== undefined && normalization.size.applied !== undefined) {
    metadata.requestedSize = normalization.size.requested;
    metadata.normalizedSize = normalization.size.applied;
  }
  if (normalization?.aspectRatio?.applied !== undefined) {
    if (normalization.aspectRatio.requested !== undefined) {
      metadata.requestedAspectRatio = normalization.aspectRatio.requested;
    }
    metadata.normalizedAspectRatio = normalization.aspectRatio.applied;
    if (
      normalization.aspectRatio.derivedFrom === "size" &&
      params.requestedSizeForDerivedAspectRatio
    ) {
      metadata.requestedSize = params.requestedSizeForDerivedAspectRatio;
      metadata.aspectRatioDerivedFromSize = deriveAspectRatioFromSize(
        params.requestedSizeForDerivedAspectRatio,
      );
    }
  }
  if (
    normalization?.resolution?.requested !== undefined &&
    normalization.resolution.applied !== undefined
  ) {
    metadata.requestedResolution = normalization.resolution.requested;
    metadata.normalizedResolution = normalization.resolution.applied;
  }
  if (
    normalization?.durationSeconds?.requested !== undefined &&
    normalization.durationSeconds.applied !== undefined
  ) {
    metadata.requestedDurationSeconds = normalization.durationSeconds.requested;
    metadata.normalizedDurationSeconds = normalization.durationSeconds.applied;
    if (
      params.includeSupportedDurationSeconds &&
      normalization.durationSeconds.supportedValues?.length
    ) {
      metadata.supportedDurationSeconds = normalization.durationSeconds.supportedValues;
    }
  }
  return metadata;
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
