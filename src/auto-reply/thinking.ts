import {
  formatThinkingLevels as formatThinkingLevelsFallback,
  formatXHighModelHint,
  isBinaryThinkingProvider as isBinaryThinkingProviderFallback,
  listThinkingLevelLabels as listThinkingLevelLabelsFallback,
  listThinkingLevels as listThinkingLevelsFallback,
  normalizeProviderId,
  normalizeThinkLevel,
  resolveThinkingDefaultForModel as resolveThinkingDefaultForModelFallback,
} from "./thinking.shared.js";
import type {
  ElevatedLevel,
  ElevatedMode,
  NoticeLevel,
  ReasoningLevel,
  ThinkLevel,
  ThinkingCatalogEntry,
  UsageDisplayLevel,
  VerboseLevel,
} from "./thinking.shared.js";
export {
  formatXHighModelHint,
  normalizeElevatedLevel,
  normalizeFastMode,
  normalizeNoticeLevel,
  normalizeReasoningLevel,
  normalizeThinkLevel,
  normalizeUsageDisplay,
  normalizeVerboseLevel,
  resolveElevatedMode,
  resolveResponseUsageMode,
} from "./thinking.shared.js";
export type {
  ElevatedLevel,
  ElevatedMode,
  NoticeLevel,
  ReasoningLevel,
  ThinkLevel,
  ThinkingCatalogEntry,
  UsageDisplayLevel,
  VerboseLevel,
} from "./thinking.shared.js";
import {
  resolveProviderBinaryThinking,
  resolveProviderDefaultThinkingLevel,
  resolveProviderXHighThinking,
} from "../plugins/provider-runtime.js";

const CLAUDE_46_MODEL_RE = /claude-(?:opus|sonnet)-4(?:\.|-)6(?:$|[-.:])/i;

export type EffectiveThinkLevel = ThinkLevel | "on";

export type ThinkingCapabilities = {
  binaryThinking?: boolean;
  nativeAdaptive?: boolean;
  reasoningSupported?: boolean;
};

export type EffectiveThinkingResolution =
  | {
      requested: ThinkLevel;
      effective: EffectiveThinkLevel;
      status: "exact";
    }
  | {
      requested: ThinkLevel;
      effective: EffectiveThinkLevel;
      status: "downgraded";
      reason: "adaptive_best_effort" | "binary_enabled";
    }
  | {
      requested: ThinkLevel;
      status: "unsupported";
      reason: "reasoning_unsupported";
    };

export function isBinaryThinkingProvider(provider?: string | null, model?: string | null): boolean {
  const normalizedProvider = normalizeProviderId(provider);
  if (!normalizedProvider) {
    return false;
  }

  const pluginDecision = resolveProviderBinaryThinking({
    provider: normalizedProvider,
    context: {
      provider: normalizedProvider,
      modelId: model?.trim() ?? "",
    },
  });
  if (typeof pluginDecision === "boolean") {
    return pluginDecision;
  }
  return isBinaryThinkingProviderFallback(provider);
}

export function supportsNativeAdaptiveThinking(
  provider?: string | null,
  model?: string | null,
): boolean {
  const normalizedProvider = normalizeProviderId(provider);
  const normalizedModel = model?.trim().toLowerCase() ?? "";
  const isAnthropicFamily =
    normalizedProvider === "anthropic" || normalizedProvider === "amazon-bedrock";
  return isAnthropicFamily && CLAUDE_46_MODEL_RE.test(normalizedModel);
}

export function supportsXHighThinking(provider?: string | null, model?: string | null): boolean {
  const modelKey = model?.trim().toLowerCase();
  if (!modelKey) {
    return false;
  }
  const providerKey = normalizeProviderId(provider);
  if (providerKey) {
    const pluginDecision = resolveProviderXHighThinking({
      provider: providerKey,
      context: {
        provider: providerKey,
        modelId: modelKey,
      },
    });
    if (typeof pluginDecision === "boolean") {
      return pluginDecision;
    }
  }
  return false;
}

export function listThinkingLevels(provider?: string | null, model?: string | null): ThinkLevel[] {
  const levels = listThinkingLevelsFallback(provider, model);
  if (supportsXHighThinking(provider, model)) {
    levels.splice(levels.length - 1, 0, "xhigh");
  }
  return levels;
}

export function listThinkingLevelLabels(provider?: string | null, model?: string | null): string[] {
  if (isBinaryThinkingProvider(provider, model)) {
    return ["off", "on"];
  }
  const levels = listThinkingLevels(provider, model);
  return levels.length > 0 ? levels : listThinkingLevelLabelsFallback(provider, model);
}

export function resolveThinkingCapabilities(params?: {
  provider?: string | null;
  model?: string | null;
  binaryThinking?: boolean;
  nativeAdaptive?: boolean;
  reasoningSupported?: boolean;
}): ThinkingCapabilities {
  const capabilities: ThinkingCapabilities = {};
  const binaryThinking =
    params?.binaryThinking ??
    (params?.provider ? isBinaryThinkingProvider(params.provider, params?.model) : undefined);
  if (binaryThinking !== undefined) {
    capabilities.binaryThinking = binaryThinking;
  }
  const nativeAdaptive =
    params?.nativeAdaptive ??
    (params?.provider || params?.model
      ? supportsNativeAdaptiveThinking(params?.provider, params?.model)
      : undefined);
  if (params?.nativeAdaptive !== undefined || nativeAdaptive === true) {
    capabilities.nativeAdaptive = nativeAdaptive;
  }
  if (params?.reasoningSupported !== undefined) {
    capabilities.reasoningSupported = params.reasoningSupported;
  }
  return capabilities;
}

export function formatThinkingLevels(
  provider?: string | null,
  model?: string | null,
  separator = ", ",
): string {
  return supportsXHighThinking(provider, model)
    ? listThinkingLevelLabels(provider, model).join(separator)
    : formatThinkingLevelsFallback(provider, model, separator);
}

export function resolveThinkingDefaultForModel(params: {
  provider: string;
  model: string;
  catalog?: ThinkingCatalogEntry[];
}): ThinkLevel {
  const normalizedProvider = normalizeProviderId(params.provider);
  const normalizedModel = params.model.trim().toLowerCase();
  const candidate = params.catalog?.find(
    (entry) => entry.provider === params.provider && entry.id === params.model,
  );
  const pluginDecision = resolveProviderDefaultThinkingLevel({
    provider: normalizedProvider,
    context: {
      provider: normalizedProvider,
      modelId: params.model,
      reasoning: candidate?.reasoning,
    },
  });
  if (pluginDecision) {
    return pluginDecision;
  }
  if (supportsNativeAdaptiveThinking(normalizedProvider, normalizedModel)) {
    return "adaptive";
  }
  return resolveThinkingDefaultForModelFallback(params);
}

export function resolveEffectiveThinking(params: {
  requested: ThinkLevel;
  capabilities?: ThinkingCapabilities;
}): EffectiveThinkingResolution {
  const capabilities = params.capabilities ?? {};

  if (params.requested === "off") {
    return { requested: "off", effective: "off", status: "exact" };
  }

  if (capabilities.reasoningSupported === false) {
    return {
      requested: params.requested,
      status: "unsupported",
      reason: "reasoning_unsupported",
    };
  }

  if (capabilities.binaryThinking) {
    return {
      requested: params.requested,
      effective: "on",
      status: "downgraded",
      reason: "binary_enabled",
    };
  }

  if (params.requested === "adaptive") {
    if (capabilities.nativeAdaptive) {
      return {
        requested: "adaptive",
        effective: "adaptive",
        status: "exact",
      };
    }
    return {
      requested: "adaptive",
      effective: "medium",
      status: "downgraded",
      reason: "adaptive_best_effort",
    };
  }

  return {
    requested: params.requested,
    effective: params.requested,
    status: "exact",
  };
}

export function formatEffectiveThinkingResolution(
  resolution: EffectiveThinkingResolution,
): string | undefined {
  if (resolution.status === "unsupported") {
    return "Reasoning is not supported for this model.";
  }
  if (resolution.status === "downgraded" && resolution.reason === "adaptive_best_effort") {
    return `Adaptive thinking is not supported natively; using ${resolution.effective} instead.`;
  }
  if (resolution.status === "downgraded" && resolution.reason === "binary_enabled") {
    return "Binary thinking only supports off/on; using on instead.";
  }
  return undefined;
}
