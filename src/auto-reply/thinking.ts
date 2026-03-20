import type { OpenClawConfig } from "../config/types.js";
import {
  formatThinkingLevels as formatThinkingLevelsFallback,
  formatXHighModelHint as formatXHighModelHintFallback,
  isBinaryThinkingProvider as isBinaryThinkingProviderFallback,
  listThinkingLevelLabels as listThinkingLevelLabelsFallback,
  listThinkingLevels as listThinkingLevelsFallback,
  normalizeProviderId,
  resolveThinkingDefaultForModel as resolveThinkingDefaultForModelFallback,
  supportsBuiltInXHighThinking,
} from "./thinking.shared.js";
import type { ThinkLevel, ThinkingCatalogEntry } from "./thinking.shared.js";
export {
  normalizeElevatedLevel,
  normalizeFastMode,
  normalizeNoticeLevel,
  normalizeReasoningLevel,
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

export type ThinkingSupportSource = {
  config?: Pick<OpenClawConfig, "models"> | null;
  catalog?: ThinkingCatalogEntry[] | null;
};

function normalizeModelId(model?: string | null): string {
  return model?.trim().toLowerCase() ?? "";
}

function normalizeModelRef(provider?: string | null, model?: string | null): string {
  const providerKey = normalizeProviderId(provider);
  const modelKey = normalizeModelId(model);
  return providerKey && modelKey ? `${providerKey}/${modelKey}` : "";
}

function resolveCatalogXHighOverride(
  provider?: string | null,
  model?: string | null,
  source?: ThinkingSupportSource,
): boolean | undefined {
  const ref = normalizeModelRef(provider, model);
  if (!ref) {
    return undefined;
  }
  const entry = source?.catalog?.find(
    (candidate) => normalizeModelRef(candidate.provider, candidate.id) === ref,
  );
  return typeof entry?.compat?.supportsXHighThinking === "boolean"
    ? entry.compat.supportsXHighThinking
    : undefined;
}

function resolveConfigXHighOverride(
  provider?: string | null,
  model?: string | null,
  source?: ThinkingSupportSource,
): boolean | undefined {
  const providerKey = normalizeProviderId(provider);
  const modelKey = normalizeModelId(model);
  if (!providerKey || !modelKey) {
    return undefined;
  }

  const providers = source?.config?.models?.providers;
  if (!providers || typeof providers !== "object") {
    return undefined;
  }

  for (const [configuredProviderId, configuredProvider] of Object.entries(providers)) {
    if (normalizeProviderId(configuredProviderId) !== providerKey) {
      continue;
    }
    if (!configuredProvider || typeof configuredProvider !== "object") {
      continue;
    }
    const configuredModels = (configuredProvider as { models?: unknown }).models;
    if (!Array.isArray(configuredModels)) {
      continue;
    }
    for (const configuredModel of configuredModels) {
      if (!configuredModel || typeof configuredModel !== "object") {
        continue;
      }
      const configuredModelId = (configuredModel as { id?: unknown }).id;
      if (
        typeof configuredModelId !== "string" ||
        normalizeModelId(configuredModelId) !== modelKey
      ) {
        continue;
      }
      const compat = (configuredModel as { compat?: { supportsXHighThinking?: unknown } }).compat;
      if (typeof compat?.supportsXHighThinking === "boolean") {
        return compat.supportsXHighThinking;
      }
    }
  }

  return undefined;
}

function resolveExplicitXHighOverride(
  provider?: string | null,
  model?: string | null,
  source?: ThinkingSupportSource,
): boolean | undefined {
  return (
    resolveCatalogXHighOverride(provider, model, source) ??
    resolveConfigXHighOverride(provider, model, source)
  );
}

function collectExplicitXHighRefs(
  source?: ThinkingSupportSource,
): Array<{ provider?: string | null; model?: string | null; ref: string; supported: boolean }> {
  const out = new Map<
    string,
    { provider?: string | null; model?: string | null; ref: string; supported: boolean }
  >();

  const add = (provider?: string | null, model?: string | null, supported?: unknown) => {
    if (typeof supported !== "boolean") {
      return;
    }
    const ref = normalizeModelRef(provider, model);
    if (!ref) {
      return;
    }
    out.set(ref, { provider, model, ref, supported });
  };

  const providers = source?.config?.models?.providers;
  if (providers && typeof providers === "object") {
    for (const [providerId, providerConfig] of Object.entries(providers)) {
      const configuredModels =
        providerConfig && typeof providerConfig === "object"
          ? (providerConfig as { models?: unknown }).models
          : undefined;
      if (!Array.isArray(configuredModels)) {
        continue;
      }
      for (const configuredModel of configuredModels) {
        if (!configuredModel || typeof configuredModel !== "object") {
          continue;
        }
        const modelId = (configuredModel as { id?: unknown }).id;
        const compat = (configuredModel as { compat?: { supportsXHighThinking?: unknown } }).compat;
        add(
          providerId,
          typeof modelId === "string" ? modelId : undefined,
          compat?.supportsXHighThinking,
        );
      }
    }
  }

  // Match resolveExplicitXHighOverride(): catalog entries override config for the same ref.
  for (const entry of source?.catalog ?? []) {
    add(entry.provider, entry.id, entry.compat?.supportsXHighThinking);
  }

  return [...out.values()];
}

function listSupportedXHighModelRefs(source?: ThinkingSupportSource): string[] {
  return collectExplicitXHighRefs(source)
    .filter((entry) => entry.supported && !isBinaryThinkingProvider(entry.provider, entry.model))
    .map((entry) => entry.ref);
}

export function isBinaryThinkingProvider(provider?: string | null, model?: string | null): boolean {
  if (isBinaryThinkingProviderFallback(provider)) {
    return true;
  }
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

export function supportsXHighThinking(
  provider?: string | null,
  model?: string | null,
  source?: ThinkingSupportSource,
): boolean {
  if (isBinaryThinkingProvider(provider, model)) {
    return false;
  }

  const explicitOverride = resolveExplicitXHighOverride(provider, model, source);
  if (typeof explicitOverride === "boolean") {
    return explicitOverride;
  }

  const modelKey = normalizeModelId(model);
  if (!modelKey) {
    return false;
  }
  if (supportsBuiltInXHighThinking(provider, modelKey)) {
    return true;
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

export function listThinkingLevels(
  provider?: string | null,
  model?: string | null,
  source?: ThinkingSupportSource,
): ThinkLevel[] {
  const levels = listThinkingLevelsFallback(provider, model);
  if (supportsXHighThinking(provider, model, source)) {
    levels.splice(levels.length - 1, 0, "xhigh");
  }
  return levels;
}

export function listThinkingLevelLabels(
  provider?: string | null,
  model?: string | null,
  source?: ThinkingSupportSource,
): string[] {
  if (isBinaryThinkingProvider(provider, model)) {
    return ["off", "on"];
  }
  return supportsXHighThinking(provider, model, source)
    ? listThinkingLevels(provider, model, source)
    : listThinkingLevelLabelsFallback(provider, model);
}

export function formatThinkingLevels(
  provider?: string | null,
  model?: string | null,
  separator = ", ",
  source?: ThinkingSupportSource,
): string {
  return supportsXHighThinking(provider, model, source)
    ? listThinkingLevelLabels(provider, model, source).join(separator)
    : formatThinkingLevelsFallback(provider, model, separator);
}

export function formatXHighModelHint(source?: ThinkingSupportSource): string {
  const explicitRefs = listSupportedXHighModelRefs(source);
  if (explicitRefs.length === 0) {
    return formatXHighModelHintFallback();
  }
  return `${formatXHighModelHintFallback()} or config-defined models: ${explicitRefs.join(", ")}`;
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
