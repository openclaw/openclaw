import { ensureAuthProfileStore, upsertAuthProfileWithLock } from "../agents/auth-profiles.js";
import { resolveOllamaApiBase } from "../agents/models-config.providers.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";
export const OLLAMA_V1_BASE_URL = "http://127.0.0.1:11434/v1";
export const OLLAMA_DEFAULT_CONTEXT_WINDOW = 128000;
export const OLLAMA_DEFAULT_MAX_TOKENS = 8192;
export const OLLAMA_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

interface OllamaDiscoveredModel {
  id: string;
  contextWindow?: number;
}

async function discoverOllamaModelsForSetup(apiBase: string): Promise<OllamaDiscoveredModel[]> {
  try {
    const response = await fetch(`${apiBase}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as { models?: Array<{ name: string }> };
    if (!data.models || data.models.length === 0) {
      return [];
    }

    // Limit to first 50 models and process in batches of 8 for concurrency
    const modelsToProcess = data.models.slice(0, 50);
    const batchSize = 8;
    const discovered: OllamaDiscoveredModel[] = [];

    for (let i = 0; i < modelsToProcess.length; i += batchSize) {
      const batch = modelsToProcess.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(async (model): Promise<OllamaDiscoveredModel> => {
          const modelId = model.name;
          let contextWindow: number | undefined;
          try {
            const showResp = await fetch(`${apiBase}/api/show`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: modelId }),
              signal: AbortSignal.timeout(3000),
            });
            if (showResp.ok) {
              const showData = (await showResp.json()) as {
                model_info?: Record<string, unknown>;
              };
              if (showData.model_info) {
                for (const [key, value] of Object.entries(showData.model_info)) {
                  if (
                    key.endsWith(".context_length") &&
                    typeof value === "number" &&
                    Number.isFinite(value)
                  ) {
                    contextWindow = Math.floor(value);
                    break;
                  }
                }
              }
            }
          } catch {
            // Ignore errors for individual model queries
          }
          return { id: modelId, contextWindow };
        }),
      );
      discovered.push(...batchResults);
    }

    return discovered;
  } catch {
    return [];
  }
}

export async function promptAndConfigureOllama(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  agentDir?: string;
}): Promise<{ config: OpenClawConfig; modelId: string; modelRef: string }> {
  const baseUrlRaw = await params.prompter.text({
    message: "Ollama base URL",
    initialValue: OLLAMA_DEFAULT_BASE_URL,
    placeholder: OLLAMA_DEFAULT_BASE_URL,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });

  const baseUrl = String(baseUrlRaw ?? "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1$/i, "");
  const apiBase = resolveOllamaApiBase(baseUrl);
  const v1BaseUrl = `${apiBase}/v1`;

  // Try to auto-discover models
  const discoveredModels = await discoverOllamaModelsForSetup(apiBase);

  let modelId: string;
  let contextWindow: number | undefined;

  if (discoveredModels.length > 0) {
    const choices = discoveredModels.map((m) => ({
      value: m.id,
      label: m.id,
      hint: m.contextWindow ? `ctx: ${Math.floor(m.contextWindow / 1024)}k` : undefined,
    }));

    const selectedModel = await params.prompter.select({
      message: `Found ${discoveredModels.length} Ollama model(s). Select one:`,
      options: choices,
    });
    modelId = String(selectedModel);
    const selected = discoveredModels.find((m) => m.id === modelId);
    contextWindow = selected?.contextWindow;
  } else {
    // No models discovered - prompt user
    await params.prompter.note(
      "No Ollama models found. Make sure Ollama is running and you have pulled at least one model.\n" +
        "Run: ollama pull <model-name> (e.g., ollama pull llama3.1:8b)",
      "No models found",
    );
    const modelIdRaw = await params.prompter.text({
      message: "Ollama model name",
      placeholder: "llama3.1:8b",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    });
    modelId = String(modelIdRaw ?? "").trim();
  }

  const modelRef = `ollama/${modelId}`;

  // Store auth profile - but preserve existing non-placeholder credentials
  const existingStore = ensureAuthProfileStore(params.agentDir);
  const existingProfile = existingStore.profiles["ollama:default"];
  const isPlaceholderKey =
    existingProfile?.type === "api_key" && existingProfile.key === "ollama-local";

  // Only write the placeholder if no profile exists or the existing one is also a placeholder
  if (!existingProfile || isPlaceholderKey) {
    await upsertAuthProfileWithLock({
      profileId: "ollama:default",
      credential: { type: "api_key", provider: "ollama", key: "ollama-local" },
      agentDir: params.agentDir,
    });
  }

  // Build the provider config
  const modelConfig: ModelDefinitionConfig = {
    id: modelId,
    name: modelId,
    reasoning: modelId.toLowerCase().includes("r1") || modelId.toLowerCase().includes("reasoning"),
    input: ["text"],
    cost: OLLAMA_DEFAULT_COST,
    contextWindow: contextWindow ?? OLLAMA_DEFAULT_CONTEXT_WINDOW,
    maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
  };

  const nextConfig: OpenClawConfig = {
    ...params.cfg,
    models: {
      ...params.cfg.models,
      mode: params.cfg.models?.mode ?? "merge",
      providers: {
        ...params.cfg.models?.providers,
        ollama: {
          baseUrl: v1BaseUrl,
          api: "ollama",
          apiKey: "ollama-local",
          models: [modelConfig],
        },
      },
    },
  };

  return { config: nextConfig, modelId, modelRef };
}
