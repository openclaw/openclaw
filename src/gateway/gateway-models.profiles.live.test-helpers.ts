import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeGooglePreviewModelId } from "@openclaw/model-catalog-core/provider-model-id-normalize";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveBuiltInModelSuppressionFromManifest } from "../agents/model-suppression.js";
import {
  createLiveTargetMatcher,
  findUnmatchedLiveModelSelectors,
} from "../agents/test-helpers/live-target-matcher.js";
import type { OpenClawConfig } from "../config/types.js";
import type { ModelRegistry } from "../llm/model-registry.js";
import {
  clampThinkingLevel,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "../plugin-sdk/llm.js";
import { resolveEffectiveThinkingProfile } from "../plugins/provider-thinking.js";
import type { ProviderDefaultThinkingPolicyContext } from "../plugins/provider-thinking.types.js";

/** Keeps strict provider proofs scoped to their admitted agent and child runs. */
export function isolateLiveGatewayConfig(cfg: OpenClawConfig): OpenClawConfig {
  return {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      controlUi: {
        ...cfg.gateway?.controlUi,
        // Session-observer digests are independent utility-model traffic and can
        // select the current candidate while a strict wire proof is active.
        sessionObserver: false,
      },
    },
  };
}

const GATEWAY_LIVE_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
type GatewayLiveThinkingLevel = (typeof GATEWAY_LIVE_THINKING_LEVELS)[number];

export function resolveGatewayLiveModelThinkingLevel(params: {
  model: Model;
  requestedLevel: string;
}): string {
  const { model, requestedLevel } = params;
  const normalized = requestedLevel.trim().toLowerCase();
  if (!isGatewayLiveThinkingLevel(normalized)) {
    return requestedLevel;
  }
  const profile = resolveEffectiveThinkingProfile({
    provider: model.provider,
    context: {
      provider: model.provider,
      modelId: model.id,
      api: model.api,
      agentRuntime: "openclaw",
      reasoning: model.reasoning,
      thinkingLevelMap: model.thinkingLevelMap,
      compat: getProviderThinkingModelCompat(model),
    },
  });
  if (profile) {
    const levelIds = profile.levels.map((level) => level.id);
    if (levelIds.some((level) => level === normalized)) {
      if (normalized === "ultra") {
        return normalized;
      }
      const clamped = clampThinkingLevel(model, normalized as ModelThinkingLevel);
      if (normalized === "max" && clamped !== normalized) {
        throw new Error(
          `${model.provider}/${model.id} advertises max but model metadata clamps it to ${clamped}`,
        );
      }
      return clamped;
    }
    if (normalized === "max" || normalized === "ultra") {
      throw new Error(`${model.provider}/${model.id} does not advertise ${normalized}`);
    }
    if (profile.defaultLevel) {
      return clampThinkingLevel(model, profile.defaultLevel as ModelThinkingLevel);
    }
    if (levelIds.length === 1) {
      const [onlyLevel] = levelIds;
      return onlyLevel
        ? clampThinkingLevel(model, onlyLevel as ModelThinkingLevel)
        : requestedLevel;
    }
  }
  if (normalized === "ultra") {
    throw new Error(`${model.provider}/${model.id} does not advertise ultra`);
  }
  const clamped = clampThinkingLevel(model, normalized as ModelThinkingLevel);
  if (normalized === "max" && clamped !== normalized) {
    throw new Error(`${model.provider}/${model.id} clamps max to ${clamped}`);
  }
  return clamped;
}

function getProviderThinkingModelCompat(
  model: Model,
): ProviderDefaultThinkingPolicyContext["compat"] {
  const record = model.compat;
  if (!isRecord(record)) {
    return undefined;
  }
  const thinkingFormat =
    typeof record.thinkingFormat === "string" ? record.thinkingFormat : undefined;
  const supportsReasoningEffort =
    typeof record.supportsReasoningEffort === "boolean"
      ? record.supportsReasoningEffort
      : undefined;
  const supportedReasoningEfforts =
    Array.isArray(record.supportedReasoningEfforts) &&
    record.supportedReasoningEfforts.every((value) => typeof value === "string")
      ? record.supportedReasoningEfforts
      : record.supportedReasoningEfforts === null
        ? null
        : undefined;
  return thinkingFormat ||
    supportsReasoningEffort !== undefined ||
    supportedReasoningEfforts !== undefined
    ? {
        ...(thinkingFormat ? { thinkingFormat } : {}),
        ...(supportsReasoningEffort !== undefined ? { supportsReasoningEffort } : {}),
        ...(supportedReasoningEfforts !== undefined ? { supportedReasoningEfforts } : {}),
      }
    : undefined;
}

export function resolveGatewayLiveThinkingLevel(params: { raw?: string; smoke: boolean }): string {
  const raw = params.raw?.trim().toLowerCase();
  if (!raw) {
    return params.smoke ? "low" : "high";
  }
  return isGatewayLiveThinkingLevel(raw) ? raw : params.smoke ? "low" : "high";
}

function isGatewayLiveThinkingLevel(value: string): value is GatewayLiveThinkingLevel {
  return GATEWAY_LIVE_THINKING_LEVELS.some((level) => level === value);
}

const EXPLICIT_LIVE_FALLBACK_CONTEXT_WINDOW = 128_000;

export function createGatewayLiveTestModel(provider: string, id: string): Model {
  return {
    provider,
    id,
    name: id,
    api: resolveExplicitLiveFallbackApi(provider),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 100,
    reasoning: false,
  } as Model;
}

const EXPLICIT_LIVE_FALLBACK_API_BY_PROVIDER: Partial<Record<string, Api>> = {
  "amazon-bedrock": "bedrock-converse-stream",
};

function resolveExplicitLiveFallbackApi(provider: string): Api {
  return (
    EXPLICIT_LIVE_FALLBACK_API_BY_PROVIDER[normalizeProviderId(provider)] ?? "openai-responses"
  );
}

export function createExplicitLiveFallbackModel(provider: string, id: string): Model {
  const thinkingProfile = resolveEffectiveThinkingProfile({
    provider,
    context: {
      provider,
      modelId: id,
      agentRuntime: "openclaw",
      reasoning: true,
    },
  });
  const supportsXhigh = thinkingProfile?.levels.some((level) => level.id === "xhigh") ?? false;
  const supportsMax = thinkingProfile?.levels.some((level) => level.id === "max") ?? false;
  return {
    ...createGatewayLiveTestModel(provider, id),
    contextWindow: EXPLICIT_LIVE_FALLBACK_CONTEXT_WINDOW,
    maxTokens: 4_096,
    reasoning: thinkingProfile?.levels.some((level) => level.id !== "off") ?? false,
    ...(supportsXhigh || supportsMax
      ? {
          thinkingLevelMap: {
            ...(supportsXhigh ? { xhigh: "xhigh" } : {}),
            ...(supportsMax ? { max: "max" } : {}),
          },
        }
      : {}),
  };
}

export function parseExplicitLiveModelRef(
  raw: string,
  providerFilter: Set<string> | null,
): { provider: string; modelId: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const slash = trimmed.indexOf("/");
  if (slash !== -1) {
    const provider = normalizeProviderId(trimmed.slice(0, slash));
    const rawModelId = trimmed.slice(slash + 1).trim();
    const modelId =
      provider === "google" || provider === "google-gemini-cli" || provider === "google-vertex"
        ? normalizeGooglePreviewModelId(rawModelId)
        : rawModelId;
    return provider && modelId ? { provider, modelId } : null;
  }
  if (!providerFilter || providerFilter.size !== 1) {
    return null;
  }
  const [provider] = [...providerFilter];
  return provider ? { provider: normalizeProviderId(provider), modelId: trimmed } : null;
}

export function resolveExplicitLiveModelCandidates(params: {
  modelRegistry: Pick<ModelRegistry, "find">;
  models: Model[];
  modelFilter: Set<string>;
  providerFilter: Set<string> | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Model[] {
  const resolved = new Map<string, Model>();
  const modelKey = (model: Model) =>
    `${normalizeProviderId(model.provider)}/${model.id.toLowerCase()}`;
  for (const raw of params.modelFilter) {
    const selector = createLiveTargetMatcher({ ...params, modelFilter: new Set([raw]) });
    const ref = parseExplicitLiveModelRef(raw, params.providerFilter);
    const model = ref
      ? (params.modelRegistry.find(ref.provider, ref.modelId) ??
        (ref.provider === "amazon-bedrock"
          ? createExplicitLiveFallbackModel(ref.provider, ref.modelId)
          : undefined))
      : undefined;
    if (
      model &&
      selector.matchesProvider(model.provider) &&
      selector.matchesModel(model.provider, model.id)
    ) {
      // Targeted metadata owns an identity even if an earlier selector enumerated it.
      resolved.set(modelKey(model), model);
      continue;
    }
    for (const candidate of params.models) {
      const key = modelKey(candidate);
      if (
        !resolved.has(key) &&
        selector.matchesProvider(candidate.provider) &&
        selector.matchesModel(candidate.provider, candidate.id)
      ) {
        resolved.set(key, candidate);
      }
    }
  }
  const candidates = [...resolved.values()].filter(
    (model) =>
      !resolveBuiltInModelSuppressionFromManifest({
        provider: model.provider,
        id: model.id,
        baseUrl: model.baseUrl,
        config: params.config,
        workspaceDir: params.workspaceDir,
      })?.suppress,
  );
  const missing = findUnmatchedLiveModelSelectors({ ...params, models: candidates });
  if (missing.length > 0) {
    throw new Error(
      `[all-models] explicit model selection missed requested models: ${missing.join(", ")}.`,
    );
  }
  return candidates;
}
