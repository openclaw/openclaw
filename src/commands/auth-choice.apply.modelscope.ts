import { discoverModelScopeModels } from "../agents/modelscope-models.js";
import { normalizeApiKeyInput, validateApiKeyInput } from "./auth-choice.api-key.js";
import {
  createAuthChoiceAgentModelNoter,
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeSecretInputModeInput,
} from "./auth-choice.apply-helpers.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";
import { ensureModelAllowlistEntry } from "./model-allowlist.js";
import {
  applyAuthProfileConfig,
  applyModelScopeProviderConfig,
  setModelScopeApiKey,
  MODELSCOPE_DEFAULT_MODEL_REF,
} from "./onboard-auth.js";

export async function applyAuthChoiceModelScope(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "modelscope-api-key") {
    return null;
  }

  let nextConfig = params.config;
  let agentModelOverride: string | undefined;
  const noteAgentModel = createAuthChoiceAgentModelNoter(params);
  const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);

  const modelscopeKey = await ensureApiKeyFromOptionEnvOrPrompt({
    token: params.opts?.token,
    tokenProvider: params.opts?.tokenProvider,
    secretInputMode: requestedSecretInputMode,
    config: nextConfig,
    expectedProviders: ["modelscope"],
    provider: "modelscope",
    envLabel: "ModelScope API key",
    promptMessage: "Enter ModelScope API key",
    normalize: normalizeApiKeyInput,
    validate: validateApiKeyInput,
    prompter: params.prompter,
    setCredential: async (apiKey, mode) =>
      setModelScopeApiKey(apiKey, params.agentDir, { secretInputMode: mode }),
    noteMessage: [
      "ModelScope provides OpenAI-compatible chat completions.",
      "Get your API key from the ModelScope console: https://modelscope.cn/docs/model-service/API-Inference/intro",
    ].join("\n"),
    noteTitle: "ModelScope",
  });
  nextConfig = applyAuthProfileConfig(nextConfig, {
    profileId: "modelscope:default",
    provider: "modelscope",
    mode: "api_key",
  });

  const models = await discoverModelScopeModels(modelscopeKey);
  const modelRefPrefix = "modelscope/";
  const options: { value: string; label: string }[] = [];
  for (const m of models) {
    const baseRef = `${modelRefPrefix}${m.id}`;
    const label = m.name ?? m.id;
    options.push({ value: baseRef, label });
  }
  const defaultRef = MODELSCOPE_DEFAULT_MODEL_REF;
  options.sort((a, b) => {
    if (a.value === defaultRef) {
      return -1;
    }
    if (b.value === defaultRef) {
      return 1;
    }
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });
  const selectedModelRef =
    options.length === 0
      ? defaultRef
      : options.length === 1
        ? options[0].value
        : await params.prompter.select({
            message: "Default ModelScope model",
            options,
            initialValue: options.some((o) => o.value === defaultRef)
              ? defaultRef
              : options[0].value,
          });

  const applied = await applyDefaultModelChoice({
    config: nextConfig,
    setDefaultModel: params.setDefaultModel,
    defaultModel: selectedModelRef,
    applyDefaultConfig: (config) => {
      const withProvider = applyModelScopeProviderConfig(config);
      const existingModel = withProvider.agents?.defaults?.model;
      const withPrimary = {
        ...withProvider,
        agents: {
          ...withProvider.agents,
          defaults: {
            ...withProvider.agents?.defaults,
            model: {
              ...(existingModel && typeof existingModel === "object" && "fallbacks" in existingModel
                ? {
                    fallbacks: (existingModel as { fallbacks?: string[] }).fallbacks,
                  }
                : {}),
              primary: selectedModelRef,
            },
          },
        },
      };
      return ensureModelAllowlistEntry({
        cfg: withPrimary,
        modelRef: selectedModelRef,
      });
    },
    applyProviderConfig: applyModelScopeProviderConfig,
    noteDefault: selectedModelRef,
    noteAgentModel,
    prompter: params.prompter,
  });
  nextConfig = applied.config;
  agentModelOverride = applied.agentModelOverride ?? agentModelOverride;

  return { config: nextConfig, agentModelOverride };
}
