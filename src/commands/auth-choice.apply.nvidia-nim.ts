import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { resolveEnvApiKey } from "../agents/model-auth.js";
import { upsertSharedEnvVar } from "../infra/env-file.js";
import {
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "./auth-choice.api-key.js";

const NVIDIA_NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";
const NVIDIA_NIM_DEFAULT_MODEL_ID = "nvidia/llama-3.1-nemotron-70b-instruct";
const NVIDIA_NIM_DEFAULT_MODEL_REF = `nvidia-nim/${NVIDIA_NIM_DEFAULT_MODEL_ID}`;
const NVIDIA_NIM_DEFAULT_COST = {
  input: 0.0004,
  output: 0.0006,
  cacheRead: 0,
  cacheWrite: 0,
};

// Core NVIDIA NIM models catalog
const NVIDIA_NIM_MODEL_CATALOG = [
  {
    id: "meta/llama-3.1-8b-instruct",
    name: "Llama 3.1 8B Instruct",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "meta/llama-3.1-70b-instruct",
    name: "Llama 3.1 70B Instruct",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "meta/llama-3.1-405b-instruct",
    name: "Llama 3.1 405B Instruct",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "meta/llama-3.3-70b-instruct",
    name: "Llama 3.3 70B Instruct",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: NVIDIA_NIM_DEFAULT_MODEL_ID,
    name: "Nemotron 70B Instruct",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "nvidia/llama-3.1-nemotron-ultra-253b-v1",
    name: "Nemotron Ultra 253B",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "nvidia/llama-3.3-nemotron-super-49b-v1",
    name: "Nemotron Super 49B",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "deepseek-ai/deepseek-r1",
    name: "DeepSeek R1",
    reasoning: true,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 16384,
    compat: { supportsReasoningEffort: true },
  },
  {
    id: "deepseek-ai/deepseek-v3.2",
    name: "DeepSeek V3.2",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
  },
  {
    id: "moonshotai/kimi-k2.5",
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 256000,
    maxTokens: 16384,
    compat: { supportsReasoningEffort: true },
  },
  {
    id: "meta/llama-3.2-11b-vision-instruct",
    name: "Llama 3.2 11B Vision",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "meta/llama-3.2-90b-vision-instruct",
    name: "Llama 3.2 90B Vision",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "mistralai/mistral-large-2-instruct",
    name: "Mistral Large 2",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "google/gemma-2-27b-it",
    name: "Gemma 2 27B IT",
    reasoning: false,
    input: ["text"],
    contextWindow: 8192,
    maxTokens: 8192,
  },
] as const;

type NvidiaNimCatalogEntry = (typeof NVIDIA_NIM_MODEL_CATALOG)[number];

function buildNvidiaNimModelDefinition(entry: NvidiaNimCatalogEntry) {
  const base = {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: NVIDIA_NIM_DEFAULT_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
  const compat = (entry as { compat?: { supportsReasoningEffort?: boolean } }).compat;
  return compat ? { ...base, compat } : base;
}

function applyNvidiaNimProviderConfig(cfg: Parameters<typeof applyNvidiaNimConfig>[0]["config"]) {
  const models = { ...cfg.agents?.defaults?.models };
  models[NVIDIA_NIM_DEFAULT_MODEL_REF] = {
    ...models[NVIDIA_NIM_DEFAULT_MODEL_REF],
    alias: models[NVIDIA_NIM_DEFAULT_MODEL_REF]?.alias ?? "Nemotron 70B",
  };

  const providers = { ...cfg.models?.providers };
  providers["nvidia-nim"] = {
    baseUrl: NVIDIA_NIM_BASE_URL,
    apiKey: "${NVIDIA_API_KEY}",
    auth: "api-key",
    api: "openai-completions",
    headers: { Accept: "application/json" },
    models: NVIDIA_NIM_MODEL_CATALOG.map(buildNvidiaNimModelDefinition),
  };

  return {
    ...cfg,
    models: {
      ...cfg.models,
      providers,
    },
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
      },
    },
  };
}

function applyNvidiaNimConfig(params: ApplyAuthChoiceParams): ApplyAuthChoiceResult {
  let nextConfig = applyNvidiaNimProviderConfig(params.config);
  let agentModelOverride: string | undefined;

  const existingModel = nextConfig.agents?.defaults?.model;
  nextConfig = {
    ...nextConfig,
    agents: {
      ...nextConfig.agents,
      defaults: {
        ...nextConfig.agents?.defaults,
        model: {
          ...(existingModel && "fallbacks" in (existingModel as Record<string, unknown>)
            ? { fallbacks: (existingModel as { fallbacks?: string[] }).fallbacks }
            : undefined),
          primary: NVIDIA_NIM_DEFAULT_MODEL_REF,
        },
      },
    },
  };

  if (!params.setDefaultModel && params.agentId) {
    agentModelOverride = NVIDIA_NIM_DEFAULT_MODEL_REF;
  }

  return { config: nextConfig, agentModelOverride };
}

export async function applyAuthChoiceNvidiaNim(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "nvidia-nim-api-key") {
    return null;
  }

  const envKey = resolveEnvApiKey("nvidia") ?? resolveEnvApiKey("nvidia-nim");
  if (envKey) {
    const useExisting = await params.prompter.confirm({
      message: `Use existing NVIDIA_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
      initialValue: true,
    });
    if (useExisting) {
      upsertSharedEnvVar({
        key: "NVIDIA_API_KEY",
        value: envKey.apiKey,
      });
      if (!process.env.NVIDIA_API_KEY) {
        process.env.NVIDIA_API_KEY = envKey.apiKey;
      }
      await params.prompter.note(
        `Confirmed NVIDIA_API_KEY from ${envKey.source} for NIM integration.`,
        "NVIDIA NIM",
      );
      return applyNvidiaNimConfig(params);
    }
  }

  let key: string | undefined;
  if (params.opts?.token && params.opts?.tokenProvider === "nvidia-nim") {
    key = params.opts.token;
  } else {
    key = await params.prompter.text({
      message: "Enter NVIDIA NIM API key (from build.nvidia.com)",
      validate: validateApiKeyInput,
    });
  }

  const trimmed = normalizeApiKeyInput(String(key));
  const result = upsertSharedEnvVar({
    key: "NVIDIA_API_KEY",
    value: trimmed,
  });
  process.env.NVIDIA_API_KEY = trimmed;

  await params.prompter.note(
    `Saved NVIDIA_API_KEY to ${result.path}. Models available: Llama 3.1/3.3, Nemotron 70B/253B, DeepSeek R1, Kimi K2.5`,
    "NVIDIA NIM configured",
  );

  return applyNvidiaNimConfig(params);
}
