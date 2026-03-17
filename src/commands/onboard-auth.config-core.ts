import { cancel, isCancel, select, spinner } from "@clack/prompts";
import { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
import { resolveEnvApiKey } from "../agents/model-auth.js";
import { scanCommonstackModels } from "../agents/model-scan.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyProviderConfigWithDefaultModel,
  applyOnboardAuthAgentModelsAndProviders,
} from "./onboard-auth.config-shared.js";

const COMMONSTACK_BASE_URL = "https://api.commonstack.ai/v1";
const COMMONSTACK_DEFAULT_MAX_TOKENS = 8192;

export function applyCommonstackProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const providers = { ...cfg.models?.providers };
  const existingProvider = providers.commonstack;
  const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
  const { apiKey: existingApiKey, ...existingProviderRest } = (existingProvider ?? {}) as Record<
    string,
    unknown
  > as { apiKey?: string };
  const normalizedApiKey =
    typeof existingApiKey === "string" ? existingApiKey.trim() || undefined : undefined;

  providers.commonstack = {
    ...existingProviderRest,
    baseUrl: COMMONSTACK_BASE_URL,
    api: "openai-completions",
    ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
    models: existingModels,
  };

  return applyOnboardAuthAgentModelsAndProviders(cfg, {
    agentModels: cfg.agents?.defaults?.models ?? {},
    providers,
  });
}

export async function applyCommonstackConfig(
  cfg: OpenClawConfig,
  params: {
    agentDir?: string;
    nonInteractive?: boolean;
    apiKey?: string;
    setDefaultModel?: boolean;
    noteAgentModel?: (model: string) => Promise<void>;
  },
): Promise<{ config: OpenClawConfig; selectedModel?: string }> {
  const next = applyCommonstackProviderConfig(cfg);

  if (params.nonInteractive) {
    return { config: next };
  }

  let apiKey = params.apiKey ?? resolveEnvApiKey("commonstack")?.apiKey;
  if (!apiKey) {
    const { resolveApiKeyForProvider } = await import("../agents/model-auth.js");
    try {
      const resolved = await resolveApiKeyForProvider({
        provider: "commonstack",
        cfg,
        agentDir: params.agentDir,
      });
      apiKey = resolved.apiKey;
    } catch {
      throw new Error("CommonStack API key not found. Please configure it first.");
    }
  }

  const spin = spinner();
  spin.start("Scanning CommonStack models...");
  let models;
  try {
    models = await scanCommonstackModels({
      apiKey,
      probe: false,
    });
    spin.stop();
  } catch (err) {
    spin.stop();
    throw err;
  }

  if (models.length === 0) {
    throw new Error("No CommonStack models found.");
  }

  const selectedModel = await select({
    message: "Select default CommonStack model",
    options: models.map((model) => ({
      value: model.modelRef,
      label: `${model.name} (${model.id})`,
      hint: model.pricing
        ? `$${model.pricing.prompt}/M input, $${model.pricing.completion}/M output`
        : undefined,
    })),
  });

  if (isCancel(selectedModel)) {
    cancel("Setup cancelled.");
    throw new Error("Model selection cancelled.");
  }

  const selectedModelRef = String(selectedModel);
  const existingModel = next.agents?.defaults?.model;
  const existingAgentModels = next.agents?.defaults?.models ?? {};
  const updatedConfig = {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model: {
          ...(existingModel && "fallbacks" in (existingModel as Record<string, unknown>)
            ? {
                fallbacks: (existingModel as { fallbacks?: string[] }).fallbacks,
              }
            : undefined),
          primary: selectedModelRef,
        },
        models: {
          ...existingAgentModels,
          [selectedModelRef]: existingAgentModels[selectedModelRef] ?? {},
        },
      },
    },
  };

  const selectedScanEntry = models.find((entry) => entry.modelRef === selectedModelRef);
  const selectedModelId =
    selectedScanEntry?.id ??
    (selectedModelRef.startsWith("commonstack/")
      ? selectedModelRef.slice("commonstack/".length)
      : selectedModelRef);
  const updatedWithProviderModel = applyProviderConfigWithDefaultModel(updatedConfig, {
    agentModels: updatedConfig.agents?.defaults?.models ?? {},
    providerId: "commonstack",
    api: "openai-completions",
    baseUrl: COMMONSTACK_BASE_URL,
    defaultModel: {
      id: selectedModelId,
      name: selectedScanEntry?.name?.trim() || selectedModelId,
      reasoning: false,
      input:
        selectedScanEntry?.modality?.toLowerCase().includes("image") === true
          ? ["text", "image"]
          : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow:
        typeof selectedScanEntry?.contextLength === "number" && selectedScanEntry.contextLength > 0
          ? selectedScanEntry.contextLength
          : DEFAULT_CONTEXT_TOKENS,
      maxTokens:
        typeof selectedScanEntry?.maxCompletionTokens === "number" &&
        selectedScanEntry.maxCompletionTokens > 0
          ? selectedScanEntry.maxCompletionTokens
          : COMMONSTACK_DEFAULT_MAX_TOKENS,
    },
    defaultModelId: selectedModelId,
  });

  if (params.setDefaultModel) {
    return { config: updatedWithProviderModel };
  }

  if (params.noteAgentModel) {
    await params.noteAgentModel(selectedModelRef);
  }
  return { config: updatedWithProviderModel, selectedModel: selectedModelRef };
}
