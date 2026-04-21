import { normalizeProviderId } from "../agents/provider-id.js";
import {
  listThinkingLevels as listThinkingLevelsFallback,
  resolveThinkingDefaultForModel as resolveThinkingDefaultForModelFallback,
} from "./thinking.shared.js";
import type { ThinkLevel, ThinkingCatalogEntry } from "./thinking.shared.js";
export {
  formatXHighModelHint,
  normalizeElevatedLevel,
  normalizeFastMode,
  normalizeNoticeLevel,
  normalizeReasoningLevel,
  normalizeTraceLevel,
  normalizeThinkLevel,
  normalizeUsageDisplay,
  normalizeVerboseLevel,
  resolveResponseUsageMode,
  resolveElevatedMode,
} from "./thinking.shared.js";
export type {
  ElevatedLevel,
  ElevatedMode,
  NoticeLevel,
  ReasoningLevel,
  TraceLevel,
  ThinkLevel,
  ThinkingCatalogEntry,
  UsageDisplayLevel,
  VerboseLevel,
} from "./thinking.shared.js";
import {
  resolveProviderAdaptiveThinking,
  resolveProviderBinaryThinking,
  resolveProviderDefaultThinkingLevel,
  resolveProviderXHighThinking,
} from "../plugins/provider-thinking.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";

export function isBinaryThinkingProvider(provider?: string | null, model?: string | null): boolean {
  const providerRaw = normalizeOptionalString(provider);
  const normalizedProvider = providerRaw ? normalizeProviderId(providerRaw) : "";
  if (!normalizedProvider) {
    return false;
  }

  const pluginDecision = resolveProviderBinaryThinking({
    provider: normalizedProvider,
    context: {
      provider: normalizedProvider,
      modelId: normalizeOptionalString(model) ?? "",
    },
  });
  if (typeof pluginDecision === "boolean") {
    return pluginDecision;
  }
  return false;
}

export function supportsXHighThinking(provider?: string | null, model?: string | null): boolean {
  const modelKey = normalizeOptionalLowercaseString(model);
  if (!modelKey) {
    return false;
  }
  const providerRaw = normalizeOptionalString(provider);
  const providerKey = providerRaw ? normalizeProviderId(providerRaw) : "";
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

export function supportsAdaptiveThinking(provider?: string | null, model?: string | null): boolean {
  const modelKey = normalizeOptionalLowercaseString(model);
  if (!modelKey) {
    return false;
  }
  const providerRaw = normalizeOptionalString(provider);
  const providerKey = providerRaw ? normalizeProviderId(providerRaw) : "";
  if (!providerKey) {
    return false;
  }
  const pluginDecision = resolveProviderAdaptiveThinking({
    provider: providerKey,
    context: {
      provider: providerKey,
      modelId: modelKey,
    },
  });
  return pluginDecision === true;
}

export function listThinkingLevels(provider?: string | null, model?: string | null): ThinkLevel[] {
  const levels = listThinkingLevelsFallback(provider, model);
  if (supportsXHighThinking(provider, model)) {
    levels.push("xhigh");
  }
  if (supportsAdaptiveThinking(provider, model)) {
    levels.push("adaptive");
  }
  return levels;
}

export function listThinkingLevelLabels(provider?: string | null, model?: string | null): string[] {
  if (isBinaryThinkingProvider(provider, model)) {
    return ["off", "on"];
  }
  return listThinkingLevels(provider, model);
}

export function formatThinkingLevels(
  provider?: string | null,
  model?: string | null,
  separator = ", ",
): string {
  return listThinkingLevelLabels(provider, model).join(separator);
}

export function resolveThinkingDefaultForModel(params: {
  provider: string;
  model: string;
  catalog?: ThinkingCatalogEntry[];
}): ThinkLevel {
  const normalizedProvider = normalizeProviderId(params.provider);
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
  return resolveThinkingDefaultForModelFallback(params);
}
