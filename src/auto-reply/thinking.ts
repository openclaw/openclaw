import {
  resolveProviderBinaryThinking,
  resolveProviderDefaultThinkingLevel,
  resolveProviderXHighThinking,
} from "../plugins/provider-runtime.js";
import {
  isBinaryThinkingProvider as isBinaryThinkingProviderShared,
  formatThinkingLevels as formatThinkingLevelsShared,
  listThinkingLevelLabels as listThinkingLevelLabelsShared,
  listThinkingLevels as listThinkingLevelsShared,
  resolveThinkingDefaultForModel as resolveThinkingDefaultForModelShared,
  supportsXHighThinking as supportsXHighThinkingShared,
  type ThinkingProviderQueries,
} from "./thinking-shared.js";

export type {
  ElevatedLevel,
  ElevatedMode,
  NoticeLevel,
  ReasoningLevel,
  ThinkingCatalogEntry,
  ThinkLevel,
  UsageDisplayLevel,
  VerboseLevel,
} from "./thinking-shared.js";

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
} from "./thinking-shared.js";

const providerQueries: ThinkingProviderQueries = {
  resolveBinaryThinking: resolveProviderBinaryThinking,
  resolveXHighThinking: resolveProviderXHighThinking,
  resolveDefaultThinkingLevel: (params) => resolveProviderDefaultThinkingLevel(params) ?? undefined,
};

export function isBinaryThinkingProvider(provider?: string | null, model?: string | null): boolean {
  return isBinaryThinkingProviderShared(provider, model, providerQueries);
}

export function supportsXHighThinking(provider?: string | null, model?: string | null): boolean {
  return supportsXHighThinkingShared(provider, model, providerQueries);
}

export function listThinkingLevels(
  provider?: string | null,
  model?: string | null,
): import("./thinking-shared.js").ThinkLevel[] {
  return listThinkingLevelsShared(provider, model, providerQueries);
}

export function listThinkingLevelLabels(provider?: string | null, model?: string | null): string[] {
  return listThinkingLevelLabelsShared(provider, model, providerQueries);
}

export function formatThinkingLevels(
  provider?: string | null,
  model?: string | null,
  separator = ", ",
): string {
  return formatThinkingLevelsShared(provider, model, separator, providerQueries);
}

export function resolveThinkingDefaultForModel(params: {
  provider: string;
  model: string;
  catalog?: import("./thinking-shared.js").ThinkingCatalogEntry[];
}): import("./thinking-shared.js").ThinkLevel {
  return resolveThinkingDefaultForModelShared({ ...params, queries: providerQueries });
}
