import {
  discoverHuggingfaceModels,
  isHuggingfacePolicyLocked,
} from "../agents/huggingface-models.js";
import { normalizeApiKeyInput, validateApiKeyInput } from "./auth-choice.api-key.js";
import {
  createAuthChoiceAgentModelNoter,
  ensureApiKeyFromOptionEnvOrPrompt,
} from "./auth-choice.apply-helpers.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";
import { ensureModelAllowlistEntry } from "./model-allowlist.js";
import {
  applyAuthProfileConfig,
  applyHuggingfaceProviderConfig,
  setHuggingfaceApiKey,
  HUGGINGFACE_DEFAULT_MODEL_REF,
} from "./onboard-auth.js";

export async function applyAuthChoiceHuggingface(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "huggingface-api-key") {
    return null;
  }

  let nextConfig = params.config;
  let agentModelOverride: string | undefined;
  const noteAgentModel = createAuthChoiceAgentModelNoter(params);

  const hfKey = await ensureApiKeyFromOptionEnvOrPrompt({
    token: params.opts?.token,
    tokenProvider: params.opts?.tokenProvider,
    expectedProviders: ["huggingface"],
    provider: "huggingface",
    envLabel: "Hugging Face token",
    promptMessage: "Enter Hugging Face API key (HF token)",
    normalize: normalizeApiKeyInput,
    validate: validateApiKeyInput,
    prompter: params.prompter,
    setCredential: async (apiKey) => setHuggingfaceApiKey(apiKey, params.agentDir),
    noteMessage: [
      "Hugging Face Inference Providers offer OpenAI-compatible chat completions.",
      "Create a token at: https://huggingface.co/settings/tokens (fine-grained, 'Make calls to Inference Providers').",
    ].join("\n"),
    noteTitle: "Hugging Face",
  });
  nextConfig = applyAuthProfileConfig(nextConfig, {
    profileId: "huggingface:default",
    provider: "huggingface",
    mode: "api_key",
  });

  const models = await discoverHuggingfaceModels(hfKey);
  const modelRefPrefix = "huggingface/";
  const options: { value: string; label: string }[] = [];
  for (const m of models) {
    const baseRef = `${modelRefPrefix}${m.id}`;
    const label = m.name ?? m.id;
    options.push({ value: baseRef, label });
    options.push({ value: `${baseRef}:cheapest`, label: `${label} (cheapest)` });
    options.push({ value: `${baseRef}:fastest`, label: `${label} (fastest)` });
  }
  const defaultRef = HUGGINGFACE_DEFAULT_MODEL_REF;
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
            message: "Default Hugging Face model",
            options,
            initialValue: options.some((o) => o.value === defaultRef)
              ? defaultRef
              : options[0].value,
          });

  if (isHuggingfacePolicyLocked(selectedModelRef)) {
    await params.prompter.note(
      "Provider locked — router will choose backend by cost or speed.",
      "Hugging Face",
    );
  }

  const applied = await applyDefaultModelChoice({
    config: nextConfig,
    setDefaultModel: params.setDefaultModel,
    defaultModel: selectedModelRef,
    applyDefaultConfig: (config) => {
      const withProvider = applyHuggingfaceProviderConfig(config);
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
    applyProviderConfig: applyHuggingfaceProviderConfig,
    noteDefault: selectedModelRef,
    noteAgentModel,
    prompter: params.prompter,
  });
  nextConfig = applied.config;
  agentModelOverride = applied.agentModelOverride ?? agentModelOverride;

  return { config: nextConfig, agentModelOverride };
}
