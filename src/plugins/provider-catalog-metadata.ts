import {
  BYTEPLUS_CODING_MODEL_CATALOG,
  BYTEPLUS_MODEL_CATALOG,
} from "../agents/byteplus-models.js";
import {
  DOUBAO_CODING_MODEL_CATALOG,
  DOUBAO_MODEL_CATALOG,
} from "../agents/doubao-models.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { normalizeProviderId } from "../agents/provider-id.js";
import { KIMI_MODEL_CATALOG } from "../agents/kimi-models.js";
import {
  normalizePluginsConfig,
  resolveEnableState,
} from "./config-state.js";
import type {
  ProviderAugmentModelCatalogContext,
  ProviderBuiltInModelSuppressionContext,
} from "./types.js";

const OPENAI_PROVIDER_ID = "openai";
const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
const OPENAI_DIRECT_SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const SUPPRESSED_SPARK_PROVIDERS = new Set(["openai", "azure-openai-responses"]);

function isBundledProviderEnabled(
  pluginId: string,
  config: ProviderAugmentModelCatalogContext["config"],
): boolean {
  const normalized = normalizePluginsConfig(config?.plugins);
  return resolveEnableState(pluginId, "bundled", normalized).enabled;
}

function findCatalogTemplate(params: {
  entries: ReadonlyArray<{ provider: string; id: string }>;
  providerId: string;
  templateIds: readonly string[];
}) {
  return params.templateIds
    .map((templateId) =>
      params.entries.find(
        (entry) =>
          entry.provider.toLowerCase() === params.providerId.toLowerCase() &&
          entry.id.toLowerCase() === templateId.toLowerCase(),
      ),
    )
    .find((entry) => entry !== undefined);
}

export function resolveBundledProviderBuiltInModelSuppression(
  context: ProviderBuiltInModelSuppressionContext,
) {
  if (
    !SUPPRESSED_SPARK_PROVIDERS.has(normalizeProviderId(context.provider)) ||
    context.modelId.toLowerCase() !== OPENAI_DIRECT_SPARK_MODEL_ID
  ) {
    return undefined;
  }
  return {
    suppress: true,
    errorMessage: `Unknown model: ${context.provider}/${OPENAI_DIRECT_SPARK_MODEL_ID}. ${OPENAI_DIRECT_SPARK_MODEL_ID} is only supported via openai-codex OAuth. Use openai-codex/${OPENAI_DIRECT_SPARK_MODEL_ID}.`,
  };
}

export function augmentBundledProviderCatalog(
  context: ProviderAugmentModelCatalogContext,
): ProviderAugmentModelCatalogContext["entries"] {
  const openAiGpt54Template = findCatalogTemplate({
    entries: context.entries,
    providerId: OPENAI_PROVIDER_ID,
    templateIds: ["gpt-5.2"],
  });
  const openAiGpt54ProTemplate = findCatalogTemplate({
    entries: context.entries,
    providerId: OPENAI_PROVIDER_ID,
    templateIds: ["gpt-5.2-pro", "gpt-5.2"],
  });
  const openAiGpt54MiniTemplate = findCatalogTemplate({
    entries: context.entries,
    providerId: OPENAI_PROVIDER_ID,
    templateIds: ["gpt-5-mini"],
  });
  const openAiGpt54NanoTemplate = findCatalogTemplate({
    entries: context.entries,
    providerId: OPENAI_PROVIDER_ID,
    templateIds: ["gpt-5-nano", "gpt-5-mini"],
  });
  const openAiCodexGpt54Template = findCatalogTemplate({
    entries: context.entries,
    providerId: OPENAI_CODEX_PROVIDER_ID,
    templateIds: ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex"],
  });
  const openAiCodexSparkTemplate = findCatalogTemplate({
    entries: context.entries,
    providerId: OPENAI_CODEX_PROVIDER_ID,
    templateIds: ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex"],
  });

  const byteplusModels: ModelCatalogEntry[] = BYTEPLUS_MODEL_CATALOG.map((entry) => ({
    id: entry.id,
    name: entry.name,
    provider: "byteplus",
    contextWindow: entry.contextWindow,
    reasoning: entry.reasoning,
    input: [...entry.input],
  }));

  const byteplusPlanModels: ModelCatalogEntry[] = BYTEPLUS_CODING_MODEL_CATALOG.map((entry) => ({
    id: entry.id,
    name: entry.name,
    provider: "byteplus-plan",
    contextWindow: entry.contextWindow,
    reasoning: entry.reasoning,
    input: [...entry.input],
  }));

  const volcengineModels: ModelCatalogEntry[] = DOUBAO_MODEL_CATALOG.map((entry) => ({
    id: entry.id,
    name: entry.name,
    provider: "volcengine",
    contextWindow: entry.contextWindow,
    reasoning: entry.reasoning,
    input: [...entry.input],
  }));

  const volcenginePlanModels: ModelCatalogEntry[] = DOUBAO_CODING_MODEL_CATALOG.map((entry) => ({
    id: entry.id,
    name: entry.name,
    provider: "volcengine-plan",
    contextWindow: entry.contextWindow,
    reasoning: entry.reasoning,
    input: [...entry.input],
  }));

  const kimiModels: ModelCatalogEntry[] = KIMI_MODEL_CATALOG.map((entry) => ({
    id: entry.id,
    name: entry.name,
    provider: "kimi",
    contextWindow: entry.contextWindow,
    reasoning: entry.reasoning,
    input: [...entry.input],
  }));

  return [
    openAiGpt54Template
      ? {
          ...openAiGpt54Template,
          id: "gpt-5.4",
          name: "gpt-5.4",
        }
      : undefined,
    openAiGpt54ProTemplate
      ? {
          ...openAiGpt54ProTemplate,
          id: "gpt-5.4-pro",
          name: "gpt-5.4-pro",
        }
      : undefined,
    openAiGpt54MiniTemplate
      ? {
          ...openAiGpt54MiniTemplate,
          id: "gpt-5.4-mini",
          name: "gpt-5.4-mini",
        }
      : undefined,
    openAiGpt54NanoTemplate
      ? {
          ...openAiGpt54NanoTemplate,
          id: "gpt-5.4-nano",
          name: "gpt-5.4-nano",
        }
      : undefined,
    openAiCodexGpt54Template
      ? {
          ...openAiCodexGpt54Template,
          id: "gpt-5.4",
          name: "gpt-5.4",
        }
      : undefined,
    openAiCodexSparkTemplate
      ? {
          ...openAiCodexSparkTemplate,
          id: OPENAI_DIRECT_SPARK_MODEL_ID,
          name: OPENAI_DIRECT_SPARK_MODEL_ID,
        }
      : undefined,
    ...(isBundledProviderEnabled("byteplus", context.config) ? byteplusModels : []),
    ...(isBundledProviderEnabled("byteplus", context.config) ? byteplusPlanModels : []),
    ...(isBundledProviderEnabled("volcengine", context.config) ? volcengineModels : []),
    ...(isBundledProviderEnabled("volcengine", context.config) ? volcenginePlanModels : []),
    ...(isBundledProviderEnabled("kimi", context.config) ? kimiModels : []),
  ].filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
}
