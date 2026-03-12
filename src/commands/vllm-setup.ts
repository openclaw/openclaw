import { upsertAuthProfileWithLock } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export const VLLM_DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";
export const VLLM_DEFAULT_CONTEXT_WINDOW = 128000;
export const VLLM_DEFAULT_MAX_TOKENS = 8192;
export const VLLM_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function normalizeVllmBaseUrl(raw: string): string {
  return String(raw ?? "")
    .trim()
    .replace(/\/+$/, "");
}

export function buildVllmModelDefinition(modelId: string): ModelDefinitionConfig {
  return {
    id: modelId,
    name: modelId,
    reasoning: false,
    input: ["text"],
    cost: VLLM_DEFAULT_COST,
    contextWindow: VLLM_DEFAULT_CONTEXT_WINDOW,
    maxTokens: VLLM_DEFAULT_MAX_TOKENS,
  };
}

export function applyVllmProviderConfig(params: {
  cfg: OpenClawConfig;
  baseUrl: string;
  modelId: string;
}): { config: OpenClawConfig; modelRef: string } {
  const baseUrl = normalizeVllmBaseUrl(params.baseUrl);
  const modelId = params.modelId.trim();
  const modelRef = `vllm/${modelId}`;
  const existingProvider = params.cfg.models?.providers?.vllm;
  const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
  const nextModels = [
    ...existingModels.filter((entry) => entry?.id !== modelId),
    buildVllmModelDefinition(modelId),
  ];
  const nextProvider: ModelProviderConfig = {
    ...existingProvider,
    baseUrl,
    api: "openai-completions",
    apiKey: "VLLM_API_KEY",
    models: nextModels,
  };
  const nextConfig: OpenClawConfig = {
    ...params.cfg,
    models: {
      ...params.cfg.models,
      mode: params.cfg.models?.mode ?? "merge",
      providers: {
        ...params.cfg.models?.providers,
        vllm: nextProvider,
      },
    },
  };
  return { config: nextConfig, modelRef };
}

export async function promptAndConfigureVllm(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  agentDir?: string;
}): Promise<{
  config: OpenClawConfig;
  modelId: string;
  modelRef: string;
  baseUrl: string;
  apiKey: string;
}> {
  const baseUrlRaw = await params.prompter.text({
    message: "vLLM base URL",
    initialValue: VLLM_DEFAULT_BASE_URL,
    placeholder: VLLM_DEFAULT_BASE_URL,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const apiKeyRaw = await params.prompter.text({
    message: "vLLM API key",
    placeholder: "sk-... (or any non-empty string)",
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const modelIdRaw = await params.prompter.text({
    message: "vLLM model",
    placeholder: "meta-llama/Meta-Llama-3-8B-Instruct",
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });

  const baseUrl = normalizeVllmBaseUrl(String(baseUrlRaw ?? ""));
  const apiKey = String(apiKeyRaw ?? "").trim();
  const modelId = String(modelIdRaw ?? "").trim();

  await upsertAuthProfileWithLock({
    profileId: "vllm:default",
    credential: { type: "api_key", provider: "vllm", key: apiKey },
    agentDir: params.agentDir,
  });

  const { config: nextConfig, modelRef } = applyVllmProviderConfig({
    cfg: params.cfg,
    baseUrl,
    modelId,
  });

  return { config: nextConfig, modelId, modelRef, baseUrl, apiKey };
}
