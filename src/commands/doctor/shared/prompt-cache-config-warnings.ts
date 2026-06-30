import {
  modelKey,
  legacyModelKey,
  type ModelRef,
} from "../../../agents/model-selection-normalize.js";
import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "../../../agents/provider-id.js";
import {
  buildModelAliasIndex,
  resolveModelRefFromString,
} from "../../../agents/model-selection-shared.js";
import { resolveDefaultModelForAgent } from "../../../agents/model-selection.js";
import {
  isAnthropicBedrockModel,
  isAnthropicFamilyCacheTtlEligible,
  isAnthropicModelRef,
} from "../../../agents/pi-embedded-runner/anthropic-family-cache-semantics.js";
import { isGooglePromptCacheEligible } from "../../../agents/pi-embedded-runner/prompt-cache-retention.js";
import { DEFAULT_CONTEXT_PRUNING_SETTINGS } from "../../../agents/pi-hooks/context-pruning/settings.js";
import { splitTrailingAuthProfile } from "../../../agents/model-ref-profile.js";
import { DEFAULT_HEARTBEAT_EVERY } from "../../../auto-reply/heartbeat.js";
import { parseDurationMs } from "../../../cli/parse-duration.js";
import { extractProviderFromModelRef } from "../../../config/model-refs.js";
import type { AgentConfig } from "../../../config/types.agents.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeLowercaseStringOrEmpty } from "../../../shared/string-coerce.js";

type CacheRetention = "none" | "short" | "long";
type CacheProfile = {
  retention: CacheRetention;
  retentionMs: number;
  label: string;
};
type ChatModelRef = {
  path: string;
  value: string;
  agentIndex?: number;
};
type SplitModelRef = {
  provider: string;
  modelId: string;
};
type HeartbeatModelOverride = {
  path: string;
  raw: string;
  ref: ModelRef;
};

const SHORT_CACHE_PROFILE: CacheProfile = {
  retention: "short",
  retentionMs: 5 * 60_000,
  label: "about 5m",
};
const LONG_CACHE_PROFILE: CacheProfile = {
  retention: "long",
  retentionMs: 60 * 60_000,
  label: "about 1h",
};

function parseOptionalDurationMs(raw: unknown): number | undefined {
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  try {
    return parseDurationMs(raw, { defaultUnit: "m" });
  } catch {
    return undefined;
  }
}

function readCacheRetention(raw: unknown): CacheRetention | undefined {
  return raw === "none" || raw === "short" || raw === "long" ? raw : undefined;
}

function readCacheRetentionParam(
  params: Record<string, unknown> | undefined,
): CacheRetention | undefined {
  const cacheRetention = readCacheRetention(params?.cacheRetention);
  if (cacheRetention) {
    return cacheRetention;
  }
  const legacy = params?.cacheControlTtl;
  if (legacy === "5m") {
    return "short";
  }
  if (legacy === "1h") {
    return "long";
  }
  return undefined;
}

function readStringParam(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return Boolean(raw && typeof raw === "object" && !Array.isArray(raw));
}

function splitModelRef(modelRef: string): SplitModelRef | undefined {
  const modelRefWithoutProfile = splitTrailingAuthProfile(modelRef).model;
  const provider = extractProviderFromModelRef(modelRefWithoutProfile);
  if (!provider) {
    return undefined;
  }
  const slash = modelRefWithoutProfile.indexOf("/");
  const modelId = slash >= 0 ? modelRefWithoutProfile.slice(slash + 1).trim() : "";
  if (!modelId) {
    return undefined;
  }
  return { provider, modelId };
}

function modelConfigPrimaryPath(path: string, model: unknown): string {
  return !model || typeof model === "string" || typeof model !== "object" || Array.isArray(model)
    ? path
    : `${path}.primary`;
}

function hasModelConfigPrimary(model: unknown): boolean {
  if (typeof model === "string" && model.trim()) {
    return true;
  }
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    return false;
  }
  return typeof (model as Record<string, unknown>).primary === "string";
}

function collectChatModelRefsFromModelConfig(
  path: string,
  model: unknown,
  agentIndex?: number,
): ChatModelRef[] {
  if (typeof model === "string" && model.trim()) {
    return [{ path, value: model.trim(), agentIndex }];
  }
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    return [];
  }
  const record = model as Record<string, unknown>;
  const refs: ChatModelRef[] = [];
  if (typeof record.primary === "string" && record.primary.trim()) {
    refs.push({ path: `${path}.primary`, value: record.primary.trim(), agentIndex });
  }
  if (Array.isArray(record.fallbacks)) {
    for (const [index, fallback] of record.fallbacks.entries()) {
      if (typeof fallback === "string" && fallback.trim()) {
        refs.push({ path: `${path}.fallbacks.${index}`, value: fallback.trim(), agentIndex });
      }
    }
  }
  return refs;
}

function hasAgentCacheRelevantOverrides(agent: AgentConfig): boolean {
  return Boolean(
    readCacheRetentionParam(agent?.params) ||
    (typeof agent?.heartbeat?.model === "string" && agent.heartbeat.model.trim()) ||
    (typeof agent?.heartbeat?.every === "string" && agent.heartbeat.every.trim()),
  );
}

function collectResolvedDefaultModelRef(
  cfg: OpenClawConfig,
  path: string,
  agentIndex?: number,
): ChatModelRef[] {
  const agent = agentIndex === undefined ? undefined : cfg.agents?.list?.[agentIndex];
  const agentId = typeof agent?.id === "string" && agent.id.trim() ? agent.id : undefined;
  const resolved = resolveDefaultModelForAgent({
    cfg,
    agentId,
    allowPluginNormalization: false,
  });
  return [{ path, value: `${resolved.provider}/${resolved.model}`, agentIndex }];
}

function resolveModelRefValue(
  cfg: OpenClawConfig,
  raw: string,
  defaultProvider: string,
): string | undefined {
  const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider });
  const resolved = resolveModelRefFromString({
    cfg,
    raw,
    defaultProvider,
    aliasIndex,
    allowPluginNormalization: false,
  })?.ref;
  return resolved ? `${resolved.provider}/${resolved.model}` : undefined;
}

function resolveDefaultProviderForModelConfig(
  cfg: OpenClawConfig,
  agentIndex?: number,
): string {
  const primary = collectResolvedDefaultModelRef(cfg, "", agentIndex)[0];
  return splitModelRef(primary?.value ?? "")?.provider ?? "openai";
}

function collectRuntimeChatModelRefsFromModelConfig(
  cfg: OpenClawConfig,
  path: string,
  model: unknown,
  agentIndex?: number,
): ChatModelRef[] {
  const defaultProvider = resolveDefaultProviderForModelConfig(cfg, agentIndex);
  const refs = collectChatModelRefsFromModelConfig(path, model, agentIndex).flatMap((ref) => {
    const resolved = resolveModelRefValue(cfg, ref.value, defaultProvider);
    const rawModelRef = splitTrailingAuthProfile(ref.value).model;
    if (!resolved) {
      return splitModelRef(ref.value) ? [ref] : [];
    }
    const pathSuffix =
      normalizeLowercaseStringOrEmpty(resolved) === normalizeLowercaseStringOrEmpty(rawModelRef)
        ? ""
        : " (resolved)";
    return [{ ...ref, path: `${ref.path}${pathSuffix}`, value: resolved }];
  });
  if (hasModelConfigPrimary(model)) {
    return refs;
  }
  return [
    ...collectResolvedDefaultModelRef(
      cfg,
      `${modelConfigPrimaryPath(path, model)} (resolved default)`,
      agentIndex,
    ),
    ...refs,
  ];
}

function collectChannelModelOverrideRefs(cfg: OpenClawConfig): ChatModelRef[] {
  const modelByChannel = cfg.channels?.modelByChannel;
  if (!isRecord(modelByChannel)) {
    return [];
  }
  const refs: ChatModelRef[] = [];
  for (const [channelId, channelMap] of Object.entries(modelByChannel)) {
    if (!isRecord(channelMap)) {
      continue;
    }
    for (const [targetId, raw] of Object.entries(channelMap)) {
      if (typeof raw !== "string" || !raw.trim()) {
        continue;
      }
      refs.push(
        ...collectRuntimeChatModelRefsFromModelConfig(
          cfg,
          `channels.modelByChannel.${channelId}.${targetId}`,
          raw,
        ),
      );
    }
  }
  return refs;
}

function collectPromptCacheChatModelRefs(cfg: OpenClawConfig): ChatModelRef[] {
  const refs = collectRuntimeChatModelRefsFromModelConfig(
    cfg,
    "agents.defaults.model",
    cfg.agents?.defaults?.model,
  );
  if (
    collectChatModelRefsFromModelConfig(
      "agents.defaults.subagents.model",
      cfg.agents?.defaults?.subagents?.model,
    ).length > 0
  ) {
    refs.push(
      ...collectRuntimeChatModelRefsFromModelConfig(
        cfg,
        "agents.defaults.subagents.model",
        cfg.agents?.defaults?.subagents?.model,
      ),
    );
  }
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  for (const [index, agent] of agents.entries()) {
    const explicitRefs = collectChatModelRefsFromModelConfig(
      `agents.list.${index}.model`,
      agent?.model,
      index,
    );
    if (explicitRefs.length > 0) {
      refs.push(
        ...collectRuntimeChatModelRefsFromModelConfig(
          cfg,
          `agents.list.${index}.model`,
          agent?.model,
          index,
        ),
      );
    } else if (hasAgentCacheRelevantOverrides(agent)) {
      refs.push(
        ...collectRuntimeChatModelRefsFromModelConfig(
          cfg,
          `agents.list.${index}.model (inherits agents.defaults.model)`,
          cfg.agents?.defaults?.model,
          index,
        ),
      );
    }
    if (
      collectChatModelRefsFromModelConfig(
        `agents.list.${index}.subagents.model`,
        agent?.subagents?.model,
        index,
      ).length > 0
    ) {
      refs.push(
        ...collectRuntimeChatModelRefsFromModelConfig(
          cfg,
          `agents.list.${index}.subagents.model`,
          agent?.subagents?.model,
          index,
        ),
      );
    }
  }
  refs.push(...collectChannelModelOverrideRefs(cfg));
  return refs;
}

function readEffectiveCacheRetention(
  cfg: OpenClawConfig,
  provider: string,
  modelId: string,
  agentIndex: number | undefined,
): CacheRetention | undefined {
  const defaults = cfg.agents?.defaults;
  const canonicalKey = modelKey(provider, modelId);
  const legacyKey = legacyModelKey(provider, modelId);
  const modelParams =
    defaults?.models?.[canonicalKey]?.params ??
    (legacyKey ? defaults?.models?.[legacyKey]?.params : undefined);
  const agentParams = agentIndex === undefined ? undefined : cfg.agents?.list?.[agentIndex]?.params;
  return readCacheRetentionParam({
    ...defaults?.params,
    ...modelParams,
    ...agentParams,
  });
}

function resolveDefaultModelApi(provider: string): string | undefined {
  const normalizedProvider = normalizeLowercaseStringOrEmpty(provider);
  if (normalizedProvider === "google") {
    return "google-generative-ai";
  }
  if (normalizedProvider === "google-gemini-cli") {
    return "google-gemini-cli";
  }
  if (normalizedProvider === "google-vertex") {
    return "google-vertex";
  }
  if (normalizedProvider === "moonshot") {
    return "openai-completions";
  }
  return undefined;
}

function resolveConfiguredModelApi(
  cfg: OpenClawConfig,
  provider: string,
  modelId: string,
): string | undefined {
  const providerConfig = findNormalizedProviderValue(cfg.models?.providers, provider);
  const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
  const modelConfig = providerConfig?.models?.find((model) => {
    const normalizedId = normalizeLowercaseStringOrEmpty(model.id);
    if (normalizedId === normalizedModelId) {
      return true;
    }
    const split = splitModelRef(model.id);
    return (
      split &&
      normalizeProviderId(split.provider) === normalizeProviderId(provider) &&
      normalizeLowercaseStringOrEmpty(split.modelId) === normalizedModelId
    );
  });
  return (
    readStringParam(modelConfig?.api) ??
    readStringParam(providerConfig?.api) ??
    resolveDefaultModelApi(provider)
  );
}

function isOpenAiLikeProvider(provider: string): boolean {
  const normalizedProvider = normalizeLowercaseStringOrEmpty(provider);
  return (
    normalizedProvider === "openai" ||
    normalizedProvider === "openai-codex" ||
    normalizedProvider === "openai-responses" ||
    normalizedProvider === "openai-codex-responses" ||
    normalizedProvider === "azure-openai" ||
    normalizedProvider === "azure-openai-responses"
  );
}

function isOpenAiLikeModelApi(modelApi: string | undefined): boolean {
  const normalizedModelApi = normalizeLowercaseStringOrEmpty(modelApi);
  return (
    normalizedModelApi === "openai-completions" ||
    normalizedModelApi === "openai-responses" ||
    normalizedModelApi === "openai-codex-responses" ||
    normalizedModelApi === "azure-openai-responses"
  );
}

function isStaticCacheTtlEligibleProvider(
  provider: string,
  modelId: string,
  modelApi?: string,
): boolean {
  const normalizedProvider = normalizeLowercaseStringOrEmpty(provider);
  const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
  if (
    isAnthropicFamilyCacheTtlEligible({
      provider: normalizedProvider,
      modelId: normalizedModelId,
      modelApi,
    }) ||
    ((normalizedProvider === "deepinfra" || normalizedProvider === "kilocode") &&
      isAnthropicModelRef(normalizedModelId)) ||
    isGooglePromptCacheEligible({ modelApi, modelId: normalizedModelId })
  ) {
    return true;
  }
  if (normalizedProvider === "zai") {
    return true;
  }
  if (normalizedProvider === "openrouter") {
    return ["anthropic/", "deepseek/", "moonshot/", "moonshotai/", "zai/"].some((prefix) =>
      normalizedModelId.startsWith(prefix),
    );
  }
  return false;
}

function isDoctorCacheTtlEligibleProvider(
  _cfg: OpenClawConfig,
  provider: string,
  modelId: string,
  modelApi?: string,
): boolean {
  const normalizedProvider = normalizeLowercaseStringOrEmpty(provider);
  const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
  return isStaticCacheTtlEligibleProvider(normalizedProvider, normalizedModelId, modelApi);
}

function requiresExplicitCacheRetention(provider: string, modelId: string, modelApi?: string): boolean {
  const normalizedProvider = normalizeLowercaseStringOrEmpty(provider);
  if (isGooglePromptCacheEligible({ modelApi, modelId })) {
    return true;
  }
  if (normalizedProvider === "anthropic" || normalizedProvider === "anthropic-vertex") {
    return false;
  }
  if (normalizedProvider === "amazon-bedrock") {
    return isAnthropicBedrockModel(modelId);
  }
  return modelApi === "anthropic-messages";
}

function formatDurationSetting(path: string, value: unknown): string {
  return typeof value === "string" && value.trim() ? `${path}="${value}"` : path;
}

function resolveHeartbeatCadence(
  cfg: OpenClawConfig,
  agentIndex: number | undefined,
): { path: string; raw: unknown; ms: number | undefined } {
  const agentEvery =
    agentIndex === undefined ? undefined : cfg.agents?.list?.[agentIndex]?.heartbeat?.every;
  if (typeof agentEvery === "string" && agentEvery.trim()) {
    return {
      path: `agents.list.${agentIndex}.heartbeat.every`,
      raw: agentEvery,
      ms: parseOptionalDurationMs(agentEvery),
    };
  }
  const raw = cfg.agents?.defaults?.heartbeat?.every;
  return {
    path: "agents.defaults.heartbeat.every",
    raw: raw ?? DEFAULT_HEARTBEAT_EVERY,
    ms: parseOptionalDurationMs(raw ?? DEFAULT_HEARTBEAT_EVERY),
  };
}

function resolveHeartbeatModelOverride(
  cfg: OpenClawConfig,
  agentIndex: number | undefined,
): HeartbeatModelOverride | undefined {
  const agentModel =
    agentIndex === undefined ? undefined : cfg.agents?.list?.[agentIndex]?.heartbeat?.model;
  const hasAgentModel = typeof agentModel === "string" && agentModel.trim();
  const path = hasAgentModel
    ? `agents.list.${agentIndex}.heartbeat.model`
    : "agents.defaults.heartbeat.model";
  const raw =
    readStringParam(agentModel) ?? readStringParam(cfg.agents?.defaults?.heartbeat?.model);
  if (!raw) {
    return undefined;
  }
  const defaultProvider = resolveDefaultProviderForModelConfig(cfg, agentIndex);
  const resolved = resolveModelRefFromString({
    raw,
    defaultProvider,
    aliasIndex: buildModelAliasIndex({ cfg, defaultProvider }),
  })?.ref;
  return resolved ? { path, raw, ref: resolved } : undefined;
}

function modelRefMatchesSplit(ref: ModelRef, model: SplitModelRef): boolean {
  return (
    normalizeLowercaseStringOrEmpty(ref.provider) ===
      normalizeLowercaseStringOrEmpty(model.provider) &&
    normalizeLowercaseStringOrEmpty(ref.model) === normalizeLowercaseStringOrEmpty(model.modelId)
  );
}

function collectHeartbeatModelOverrideWarnings(params: {
  activeModel: SplitModelRef;
  heartbeatModel: HeartbeatModelOverride | undefined;
  modelPath: string;
  modelRef: string;
}): string[] {
  const heartbeatModel = params.heartbeatModel;
  if (!heartbeatModel || modelRefMatchesSplit(heartbeatModel.ref, params.activeModel)) {
    return [];
  }
  return [
    [
      `- ${heartbeatModel.path}="${heartbeatModel.raw}" does not match ${params.modelRef} used by ${params.modelPath}, so heartbeat runs cannot refresh that prompt cache.`,
      `  Fix: remove ${heartbeatModel.path}, set it to ${params.modelRef}, or disable agents.defaults.contextPruning.mode="cache-ttl" for this config.`,
    ].join("\n"),
  ];
}

function collectRetentionWarnings(params: {
  modelRef: string;
  path: string;
  requiresExplicitRetention?: boolean;
  ttlRaw: unknown;
  ttlMs: number;
  heartbeatEveryPath: string;
  heartbeatEveryRaw: unknown;
  heartbeatEveryMs?: number;
  retention: CacheRetention | undefined;
}): string[] {
  if (params.requiresExplicitRetention && !params.retention) {
    return [
      [
        `- ${params.path} uses ${params.modelRef}, but this provider/model needs explicit cacheRetention or cacheControlTtl for agents.defaults.contextPruning.mode="cache-ttl" to maintain a prompt cache.`,
        '  Fix: set cacheRetention="short" or cacheRetention="long" for this model/agent, or set agents.defaults.contextPruning.mode="off" if prompt-cache TTL pruning is not intended.',
      ].join("\n"),
    ];
  }

  const retention = params.retention ?? "short";
  if (retention === "none") {
    return [
      [
        `- ${params.path} uses ${params.modelRef}, but effective cacheRetention is "none" while agents.defaults.contextPruning.mode="cache-ttl".`,
        '  Fix: remove cacheRetention="none" for this model/agent, or set agents.defaults.contextPruning.mode="off" if prompt-cache TTL pruning is not intended.',
      ].join("\n"),
    ];
  }

  const profile = retention === "long" ? LONG_CACHE_PROFILE : SHORT_CACHE_PROFILE;
  const warnings: string[] = [];
  if (params.ttlMs > profile.retentionMs) {
    const heartbeatClause =
      params.heartbeatEveryMs !== undefined && params.heartbeatEveryMs >= profile.retentionMs
        ? ` ${formatDurationSetting(params.heartbeatEveryPath, params.heartbeatEveryRaw)} cannot refresh it before that cache usually expires.`
        : "";
    warnings.push(
      [
        `- ${formatDurationSetting("agents.defaults.contextPruning.ttl", params.ttlRaw)} is longer than ${params.modelRef}'s effective ${profile.retention} prompt-cache retention (${profile.label}) for ${params.path}.${heartbeatClause}`,
        `  Fix: set cacheRetention="long" for this model/agent, or lower agents.defaults.contextPruning.ttl and ${params.heartbeatEveryPath} below ${profile.label}.`,
      ].join("\n"),
    );
  } else if (
    params.heartbeatEveryMs !== undefined &&
    params.heartbeatEveryMs >= profile.retentionMs
  ) {
    warnings.push(
      [
        `- ${formatDurationSetting(params.heartbeatEveryPath, params.heartbeatEveryRaw)} is not shorter than ${params.modelRef}'s effective ${profile.retention} prompt-cache retention (${profile.label}) for ${params.path}.`,
        `  Fix: lower ${params.heartbeatEveryPath} below ${profile.label}, or set cacheRetention="long" if the provider/model supports it.`,
      ].join("\n"),
    );
  }
  return warnings;
}

export function collectPromptCacheConfigWarnings(cfg: OpenClawConfig): string[] {
  const contextPruning = cfg.agents?.defaults?.contextPruning;
  if (contextPruning?.mode !== "cache-ttl") {
    return [];
  }
  const ttlMs =
    parseOptionalDurationMs(contextPruning.ttl) ?? DEFAULT_CONTEXT_PRUNING_SETTINGS.ttlMs;
  if (ttlMs <= 0) {
    return [];
  }

  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const ref of collectPromptCacheChatModelRefs(cfg)) {
    const model = splitModelRef(ref.value);
    if (!model) {
      continue;
    }
    const key = `${ref.path}:${ref.value}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const modelApi = resolveConfiguredModelApi(cfg, model.provider, model.modelId);
    const eligible = isDoctorCacheTtlEligibleProvider(
      cfg,
      model.provider,
      model.modelId,
      modelApi,
    );

    if (isOpenAiLikeProvider(model.provider) || (!eligible && isOpenAiLikeModelApi(modelApi))) {
      warnings.push(
        [
          `- ${ref.path} uses ${ref.value}, but agents.defaults.contextPruning.mode="cache-ttl" does not currently run for OpenAI-family models.`,
          "  Fix: remove cache-ttl pruning for this config, or use a cache-ttl eligible provider/model for sessions where TTL-based transcript pruning is required.",
        ].join("\n"),
      );
      continue;
    }

    if (!eligible) {
      continue;
    }
    const heartbeat = resolveHeartbeatCadence(cfg, ref.agentIndex);
    warnings.push(
      ...collectHeartbeatModelOverrideWarnings({
        activeModel: model,
        heartbeatModel: resolveHeartbeatModelOverride(cfg, ref.agentIndex),
        modelPath: ref.path,
        modelRef: ref.value,
      }),
    );
    warnings.push(
      ...collectRetentionWarnings({
        modelRef: ref.value,
        path: ref.path,
        requiresExplicitRetention: requiresExplicitCacheRetention(
          model.provider,
          model.modelId,
          modelApi,
        ),
        ttlRaw: contextPruning.ttl,
        ttlMs,
        heartbeatEveryPath: heartbeat.path,
        heartbeatEveryRaw: heartbeat.raw,
        heartbeatEveryMs: heartbeat.ms,
        retention: readEffectiveCacheRetention(cfg, model.provider, model.modelId, ref.agentIndex),
      }),
    );
  }
  return warnings;
}
