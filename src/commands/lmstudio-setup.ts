import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { resolveLocalProviderBaseUrl } from "./local-model-utils.js";

const log = createSubsystemLogger("lmstudio-setup");

export const LMSTUDIO_DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
export const LMSTUDIO_DEFAULT_CONTEXT_WINDOW = 128000;
export const LMSTUDIO_DEFAULT_MAX_TOKENS = 8192;
export const LMSTUDIO_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

type LmStudioModelsResponse = {
  data?: Array<{
    id?: string;
  }>;
};

/** Discover models from a running LM Studio instance via its OpenAI-compatible /models endpoint. */
export async function discoverLmStudioModels(baseUrl: string): Promise<ModelDefinitionConfig[]> {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return [];
  }

  const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  const url = `${trimmedBaseUrl}/models`;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      log.warn(`Failed to discover LM Studio models: ${response.status}`);
      return [];
    }
    const data = (await response.json()) as LmStudioModelsResponse;
    const models = data.data ?? [];
    if (models.length === 0) {
      log.debug("No LM Studio models found");
      return [];
    }

    return models
      .map((m) => ({ id: typeof m.id === "string" ? m.id.trim() : "" }))
      .filter((m) => Boolean(m.id))
      .map((m) => {
        const modelId = m.id;
        const lower = modelId.toLowerCase();
        const isReasoning =
          lower.includes("r1") || lower.includes("reasoning") || lower.includes("think");
        return {
          id: modelId,
          name: modelId,
          reasoning: isReasoning,
          input: ["text"],
          cost: LMSTUDIO_DEFAULT_COST,
          contextWindow: LMSTUDIO_DEFAULT_CONTEXT_WINDOW,
          maxTokens: LMSTUDIO_DEFAULT_MAX_TOKENS,
        } satisfies ModelDefinitionConfig;
      });
  } catch (error) {
    log.warn(`Failed to discover LM Studio models: ${String(error)}`);
    return [];
  }
}

export async function promptAndConfigureLmStudio(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
}): Promise<{ config: OpenClawConfig; modelIds: string[]; modelRefs: string[] }> {
  const resolvedBaseUrl = await resolveLocalProviderBaseUrl({
    prompter: params.prompter,
    defaultUrl: LMSTUDIO_DEFAULT_BASE_URL,
    providerName: "LM Studio",
  });
  const baseUrl = resolvedBaseUrl.replace(/\/+$/, "");

  // Try auto-discovery
  const discovered = await discoverLmStudioModels(baseUrl);

  let selectedModels: ModelDefinitionConfig[];

  if (discovered.length > 0) {
    await params.prompter.note(
      `Found ${discovered.length} model${discovered.length === 1 ? "" : "s"} on LM Studio`,
      "Auto-discovery",
    );

    const selection = await params.prompter.multiselect({
      message: "Select models to use (multi-select)",
      options: discovered.map((m) => ({
        value: m.id,
        label: m.id,
        hint: m.reasoning ? "reasoning" : undefined,
      })),
      initialValues: discovered.length === 1 ? [discovered[0].id] : undefined,
      searchable: true,
    });

    const selectedIds = new Set(selection.map((v) => String(v)));
    selectedModels = discovered.filter((m) => selectedIds.has(m.id));

    if (selectedModels.length === 0) {
      selectedModels = discovered;
    }
  } else {
    // Manual model entry
    const modelIdRaw = await params.prompter.text({
      message: "LM Studio model ID",
      placeholder: "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    });
    const modelId = String(modelIdRaw ?? "").trim();
    selectedModels = [
      {
        id: modelId,
        name: modelId,
        reasoning: false,
        input: ["text"],
        cost: LMSTUDIO_DEFAULT_COST,
        contextWindow: LMSTUDIO_DEFAULT_CONTEXT_WINDOW,
        maxTokens: LMSTUDIO_DEFAULT_MAX_TOKENS,
      },
    ];
  }

  const modelIds = selectedModels.map((m) => m.id);
  const modelRefs = modelIds.map((id) => `lmstudio/${id}`);

  const nextConfig: OpenClawConfig = {
    ...params.cfg,
    models: {
      ...params.cfg.models,
      mode: params.cfg.models?.mode ?? "merge",
      providers: {
        ...params.cfg.models?.providers,
        lmstudio: {
          baseUrl,
          api: "openai-completions",
          apiKey: "lmstudio",
          models: selectedModels,
        },
      },
    },
  };

  return { config: nextConfig, modelIds, modelRefs };
}
