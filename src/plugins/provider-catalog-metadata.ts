import { normalizeProviderId } from "../agents/provider-id.js";
import { findCatalogTemplate } from "./provider-catalog.js";
import type {
  ProviderAugmentModelCatalogContext,
  ProviderBuildMissingAuthMessageContext,
  ProviderBuiltInModelSuppressionContext,
} from "./types.js";

const OPENAI_PROVIDER_ID = "openai";
const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
const OPENAI_DIRECT_SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const OPENAI_CODEX_GPT54_CONTEXT_TOKENS = 1_050_000;
const OPENAI_CODEX_GPT54_MAX_TOKENS = 128_000;
const SUPPRESSED_SPARK_PROVIDERS = new Set(["openai", "azure-openai-responses"]);

export function buildBundledProviderMissingAuthMessage(
  context: ProviderBuildMissingAuthMessageContext,
) {
  if (
    normalizeProviderId(context.provider) !== OPENAI_PROVIDER_ID ||
    context.listProfileIds(OPENAI_CODEX_PROVIDER_ID).length === 0
  ) {
    return undefined;
  }
  return 'No API key found for provider "openai". You are authenticated with OpenAI Codex OAuth. Use openai-codex/gpt-5.4 (OAuth) or set OPENAI_API_KEY to use openai/gpt-5.4.';
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
    templateIds: ["gpt-5.3-codex", "gpt-5.2-codex"],
  });
  const openAiCodexSparkTemplate = findCatalogTemplate({
    entries: context.entries,
    providerId: OPENAI_CODEX_PROVIDER_ID,
    templateIds: ["gpt-5.3-codex", "gpt-5.2-codex"],
  });

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
          contextWindow: OPENAI_CODEX_GPT54_CONTEXT_TOKENS,
          maxTokens: OPENAI_CODEX_GPT54_MAX_TOKENS,
        }
      : undefined,
    openAiCodexSparkTemplate
      ? {
          ...openAiCodexSparkTemplate,
          id: OPENAI_DIRECT_SPARK_MODEL_ID,
          name: OPENAI_DIRECT_SPARK_MODEL_ID,
        }
      : undefined,
  ].filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
}
