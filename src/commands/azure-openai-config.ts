import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import {
  applyAgentDefaultModelPrimary,
  applyOnboardAuthAgentModelsAndProviders,
} from "./onboard-auth.config-shared.js";

export const AZURE_OPENAI_PROVIDER_ID = "azure-openai-responses";
export const AZURE_OPENAI_DEFAULT_MODEL_ID = "gpt-4.1";
export const AZURE_OPENAI_DEFAULT_MODEL_REF = `${AZURE_OPENAI_PROVIDER_ID}/${AZURE_OPENAI_DEFAULT_MODEL_ID}`;
export const AZURE_OPENAI_DEFAULT_API_VERSION = "v1";

function isAzureHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized.endsWith(".openai.azure.com") ||
    normalized.endsWith(".services.ai.azure.com") ||
    normalized.endsWith(".cognitiveservices.azure.com")
  );
}

export function normalizeAzureOpenAIModelId(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Azure OpenAI deployment/model ID is required.");
  }
  return normalized;
}

export function normalizeAzureOpenAIApiVersion(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Azure OpenAI API version must be a non-empty string.");
  }
  return normalized;
}

export function normalizeAzureOpenAIBaseUrl(value: string): string {
  const candidate = value.trim();
  if (!candidate) {
    throw new Error("Azure OpenAI base URL is required.");
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(
      "Azure OpenAI base URL must be a valid URL (for example: https://<resource>.openai.azure.com/openai/v1).",
    );
  }

  if (!isAzureHost(parsed.hostname)) {
    throw new Error(
      "Azure OpenAI base URL must use an Azure host (*.openai.azure.com, *.services.ai.azure.com, or *.cognitiveservices.azure.com).",
    );
  }

  return `${parsed.origin}/openai/v1`;
}

function buildAzureModelDefinition(modelId: string): ModelDefinitionConfig {
  return {
    id: modelId,
    name: `Azure OpenAI ${modelId}`,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
    compat: { supportsStore: false },
  };
}

export function applyAzureOpenAIProviderConfig(
  cfg: OpenClawConfig,
  params: { baseUrl: string; modelId: string; apiVersion?: string },
): OpenClawConfig {
  const baseUrl = normalizeAzureOpenAIBaseUrl(params.baseUrl);
  const modelId = normalizeAzureOpenAIModelId(params.modelId);
  const apiVersion = params.apiVersion
    ? normalizeAzureOpenAIApiVersion(params.apiVersion)
    : AZURE_OPENAI_DEFAULT_API_VERSION;
  const modelRef = `${AZURE_OPENAI_PROVIDER_ID}/${modelId}`;

  const agentModels = { ...cfg.agents?.defaults?.models };
  const existingModelParams = {
    ...((agentModels[modelRef]?.params as Record<string, unknown> | undefined) ?? {}),
  };
  if (apiVersion === AZURE_OPENAI_DEFAULT_API_VERSION) {
    delete existingModelParams.azureApiVersion;
  } else {
    existingModelParams.azureApiVersion = apiVersion;
  }
  agentModels[modelRef] = {
    ...agentModels[modelRef],
    alias: agentModels[modelRef]?.alias ?? "Azure OpenAI",
    params: existingModelParams,
  };

  const providers = { ...cfg.models?.providers };
  const existingProvider = providers[AZURE_OPENAI_PROVIDER_ID];
  const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
  const defaultModel = buildAzureModelDefinition(modelId);
  const mergedModels = existingModels.some((model) => model.id === modelId)
    ? existingModels
    : [...existingModels, defaultModel];
  const { apiKey: existingApiKey, ...existingProviderRest } = (existingProvider ?? {}) as {
    apiKey?: string;
  };
  const normalizedApiKey = typeof existingApiKey === "string" ? existingApiKey.trim() : undefined;

  providers[AZURE_OPENAI_PROVIDER_ID] = {
    ...existingProviderRest,
    baseUrl,
    api: "openai-responses",
    ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
    models: mergedModels.length > 0 ? mergedModels : [defaultModel],
  };

  return applyOnboardAuthAgentModelsAndProviders(cfg, {
    agentModels,
    providers,
  });
}

export function applyAzureOpenAIConfig(
  cfg: OpenClawConfig,
  params: { baseUrl: string; modelId: string; apiVersion?: string },
): OpenClawConfig {
  const next = applyAzureOpenAIProviderConfig(cfg, params);
  return applyAgentDefaultModelPrimary(next, `${AZURE_OPENAI_PROVIDER_ID}/${params.modelId.trim()}`);
}
