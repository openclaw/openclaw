import { resolveEnvApiKey } from "../agents/model-auth.js";
import type { OpenClawConfig } from "../config/config.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { formatApiKeyPreview } from "./auth-choice.api-key.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";
import {
  applyAuthProfileConfig,
  OLLAMA_DEFAULT_MODEL_REF,
  setOllamaApiKey,
} from "./onboard-auth.js";

const OLLAMA_PLACEHOLDER_KEY = "ollama";
const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const OLLAMA_TIMEOUT_MS = 8000;

function isValidHttpUrl(value: string): string | undefined {
  if (!value?.trim()) {
    return "URL is required";
  }
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:"
      ? undefined
      : "Only HTTP and HTTPS URLs are supported";
  } catch {
    return "Invalid URL format";
  }
}

async function checkOllamaReachable(
  baseUrl: string,
): Promise<{ reachable: boolean; models: string[] }> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { reachable: false, models: [] };
    }
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    if (!Array.isArray(data.models)) {
      return { reachable: true, models: [] };
    }
    const models = data.models
      .map((m) => m?.name)
      .filter((name): name is string => typeof name === "string");
    return { reachable: true, models };
  } catch {
    return { reachable: false, models: [] };
  }
}

function applyOllamaProviderConfig(cfg: OpenClawConfig, baseUrl: string): OpenClawConfig {
  if (baseUrl === OLLAMA_DEFAULT_BASE_URL) {
    return {
      ...cfg,
      models: { mode: cfg.models?.mode ?? "merge", providers: cfg.models?.providers },
    };
  }
  return {
    ...cfg,
    models: {
      mode: cfg.models?.mode ?? "merge",
      providers: {
        ...cfg.models?.providers,
        ollama: {
          baseUrl: `${baseUrl}/v1`,
          api: "openai-completions" as const,
          models: [],
        },
      },
    },
  };
}

function applyOllamaConfig(cfg: OpenClawConfig, modelRef: string, baseUrl: string): OpenClawConfig {
  const next = applyOllamaProviderConfig(cfg, baseUrl);
  const existing = next.agents?.defaults?.model;
  const fallbacks =
    existing && typeof existing === "object" && "fallbacks" in existing
      ? (existing as { fallbacks?: string[] }).fallbacks
      : undefined;
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model: { ...(fallbacks && { fallbacks }), primary: modelRef },
      },
    },
  };
}

export async function applyAuthChoiceOllama(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "ollama") {
    return null;
  }

  const { prompter, agentDir, setDefaultModel, agentId } = params;

  const useCustomEndpoint = await prompter.confirm({
    message: `Use a custom Ollama endpoint? (default: ${OLLAMA_DEFAULT_BASE_URL})`,
    initialValue: false,
  });

  let baseUrl = OLLAMA_DEFAULT_BASE_URL;
  if (useCustomEndpoint) {
    const input = await prompter.text({
      message: "Enter Ollama endpoint URL",
      initialValue: OLLAMA_DEFAULT_BASE_URL,
      validate: isValidHttpUrl,
    });
    baseUrl = typeof input === "string" && input.trim() ? input.trim() : OLLAMA_DEFAULT_BASE_URL;
  }

  const { reachable, models } = await checkOllamaReachable(baseUrl);

  if (!reachable) {
    await prompter.note(
      `Ollama is not reachable at ${baseUrl}\n\nPlease ensure Ollama is running:\n  1. Install Ollama: https://ollama.com\n  2. Start Ollama via the desktop app or run: ollama serve\n  3. Pull a model: ollama pull glm-4.7-flash\n\nThen re-run: openclaw onboard or openclaw configure`,
      "Ollama not detected",
    );
    throw new WizardCancelledError("Ollama is not reachable");
  }

  if (models.length > 0) {
    await prompter.note(`Found ${models.length} model(s).`, "Ollama");
  } else {
    await prompter.note(
      "No models found. Pull a model first:\n  ollama pull glm-4.7-flash",
      "Ollama",
    );
  }

  let apiKey = OLLAMA_PLACEHOLDER_KEY;
  const envKey = resolveEnvApiKey("ollama");
  if (envKey) {
    const useExisting = await prompter.confirm({
      message: `Use existing OLLAMA_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
      initialValue: true,
    });
    if (useExisting) {
      apiKey = envKey.apiKey;
    }
  }

  await setOllamaApiKey(apiKey, agentDir);

  let config = applyAuthProfileConfig(params.config, {
    profileId: "ollama:default",
    provider: "ollama",
    mode: "api_key",
  });

  const PREFERRED_MODELS = [
    "glm-5:cloud",
    "kimi-k2.5:cloud",
    "minimax-m2.5:cloud",
    "glm-4.7:flash",
  ];
  const preferred = PREFERRED_MODELS.find((m) => models.includes(m));
  const defaultModel = preferred
    ? `ollama/${preferred}`
    : models.length > 0
      ? `ollama/${models[0]}`
      : OLLAMA_DEFAULT_MODEL_REF;

  const applied = await applyDefaultModelChoice({
    config,
    setDefaultModel,
    defaultModel,
    applyDefaultConfig: (cfg) => applyOllamaConfig(cfg, defaultModel, baseUrl),
    applyProviderConfig: (cfg) => applyOllamaProviderConfig(cfg, baseUrl),
    noteDefault: defaultModel,
    noteAgentModel: async (model) => {
      if (agentId) {
        await prompter.note(
          `Default model set to ${model} for agent "${agentId}".`,
          "Model configured",
        );
      }
    },
    prompter,
  });

  return { config: applied.config, agentModelOverride: applied.agentModelOverride };
}
