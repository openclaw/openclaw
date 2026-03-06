import { upsertAuthProfileWithLock } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { resolveLocalProviderBaseUrl } from "./local-model-utils.js";

const log = createSubsystemLogger("vllm-setup");

export const VLLM_DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";
export const VLLM_DEFAULT_CONTEXT_WINDOW = 128000;
export const VLLM_DEFAULT_MAX_TOKENS = 8192;
export const VLLM_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

type VllmModelsResponse = {
  data?: Array<{
    id?: string;
  }>;
};

/** Discover models from a running vLLM instance via its OpenAI-compatible /models endpoint. */
async function discoverVllmSetupModels(
  baseUrl: string,
  apiKey?: string,
): Promise<ModelDefinitionConfig[]> {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return [];
  }

  const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  const url = `${trimmedBaseUrl}/models`;

  try {
    const trimmedApiKey = apiKey?.trim();
    const response = await fetch(url, {
      headers: trimmedApiKey ? { Authorization: `Bearer ${trimmedApiKey}` } : undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      log.warn(`Failed to discover vLLM models: ${response.status}`);
      return [];
    }
    const data = (await response.json()) as VllmModelsResponse;
    const models = data.data ?? [];
    if (models.length === 0) {
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
          cost: VLLM_DEFAULT_COST,
          contextWindow: VLLM_DEFAULT_CONTEXT_WINDOW,
          maxTokens: VLLM_DEFAULT_MAX_TOKENS,
        } satisfies ModelDefinitionConfig;
      });
  } catch (error) {
    log.warn(`Failed to discover vLLM models: ${String(error)}`);
    return [];
  }
}

export async function promptAndConfigureVllm(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  agentDir?: string;
}): Promise<{ config: OpenClawConfig; modelId: string; modelRef: string }> {
  const baseUrl = await resolveLocalProviderBaseUrl({
    prompter: params.prompter,
    defaultUrl: VLLM_DEFAULT_BASE_URL,
    providerName: "vLLM",
  });
  const apiKeyRaw = await params.prompter.text({
    message: "vLLM API key",
    placeholder: "sk-... (or any non-empty string)",
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });

  const apiKey = String(apiKeyRaw ?? "").trim();

  // Try auto-discovery first
  const discovered = await discoverVllmSetupModels(baseUrl, apiKey);

  let modelId: string;

  if (discovered.length > 1) {
    await params.prompter.note(
      `Found ${discovered.length} models on vLLM server`,
      "Auto-discovery",
    );
    const selection = await params.prompter.select({
      message: "Select primary vLLM model",
      options: discovered.map((m) => ({
        value: m.id,
        label: m.id,
        hint: m.reasoning ? "reasoning" : undefined,
      })),
    });
    modelId = String(selection);
  } else if (discovered.length === 1) {
    modelId = discovered[0].id;
    await params.prompter.note(`Auto-discovered model: ${modelId}`, "vLLM model found");
  } else {
    const modelIdRaw = await params.prompter.text({
      message: "vLLM model",
      placeholder: "meta-llama/Meta-Llama-3-8B-Instruct",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    });
    modelId = String(modelIdRaw ?? "").trim();
  }

  const modelRef = `vllm/${modelId}`;

  await upsertAuthProfileWithLock({
    profileId: "vllm:default",
    credential: { type: "api_key", provider: "vllm", key: apiKey },
    agentDir: params.agentDir,
  });

  const selectedModel = discovered.find((m) => m.id === modelId);
  const models: ModelDefinitionConfig[] = selectedModel
    ? [selectedModel]
    : [
        {
          id: modelId,
          name: modelId,
          reasoning: false,
          input: ["text"],
          cost: VLLM_DEFAULT_COST,
          contextWindow: VLLM_DEFAULT_CONTEXT_WINDOW,
          maxTokens: VLLM_DEFAULT_MAX_TOKENS,
        },
      ];

  const nextConfig: OpenClawConfig = {
    ...params.cfg,
    models: {
      ...params.cfg.models,
      mode: params.cfg.models?.mode ?? "merge",
      providers: {
        ...params.cfg.models?.providers,
        vllm: {
          baseUrl: baseUrl.replace(/\/+$/, ""),
          api: "openai-completions",
          apiKey: "VLLM_API_KEY",
          models,
        },
      },
    },
  };

  return { config: nextConfig, modelId, modelRef };
}
