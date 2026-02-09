import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";
import { applySelfHostedOpenAIProviderConfig } from "./onboard-auth.config-core.js";

export async function applyAuthChoiceSelfHostedOpenAI(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "self-hosted-openai-api") {
    return null;
  }

  // Prompt for the base URL of the self-hosted service
  const baseUrl = await params.prompter.text({
    message: "Enter the base URL of your self-hosted OpenAI-compatible service",
    initialValue: "http://localhost:1234/v1", // Common default for services like LM Studio
    validate: (value) => {
      if (!value || !value.trim()) {
        return "Base URL is required";
      }
      try {
        new URL(value.trim());
        return undefined;
      } catch {
        return "Please enter a valid URL";
      }
    },
  });

  // Prompt for API key if required (some self-hosted services don't require it)
  const apiKey = await params.prompter.text({
    message: "Enter API key if required (leave blank if not needed)",
    initialValue: "",
  });

  // Prompt for model name
  const modelName = await params.prompter.text({
    message: "Enter the model name to use (without provider prefix)",
    initialValue: "default-model", // This will vary depending on the user's setup
    validate: (value) => {
      if (!value || !value.trim()) {
        return "Model name is required";
      }
      if (value.includes("/")) {
        return "Model name should not contain '/'. Please enter just the model name.";
      }
      return undefined;
    },
  });

  // Prompt for provider name (default to "self-hosted")
  const providerName = await params.prompter.text({
    message: "Enter provider name",
    initialValue: "self-hosted",
    validate: (value) => {
      if (!value || !value.trim()) {
        return "Provider name is required";
      }
      return undefined;
    },
  });

  // Prompt for reasoning capability
  const reasoningInput = await params.prompter.text({
    message: "Does the model support reasoning? (true/false)",
    initialValue: "false",
    validate: (value) => {
      const trimmed = String(value).trim().toLowerCase();
      if (trimmed !== "true" && trimmed !== "false") {
        return "Please enter 'true' or 'false'";
      }
      return undefined;
    },
  });
  const reasoning = String(reasoningInput).trim().toLowerCase() === "true";

  // Prompt for context window size
  const contextWindowInput = await params.prompter.text({
    message: "Enter context window size",
    initialValue: "128000",
    validate: (value) => {
      const num = Number(value);
      if (!Number.isInteger(num) || num <= 0) {
        return "Please enter a positive integer";
      }
      return undefined;
    },
  });
  const contextWindow = Number(contextWindowInput);

  // Prompt for max tokens
  const maxTokensInput = await params.prompter.text({
    message: "Enter max tokens",
    initialValue: "8192",
    validate: (value) => {
      const num = Number(value);
      if (!Number.isInteger(num) || num <= 0) {
        return "Please enter a positive integer";
      }
      return undefined;
    },
  });
  const maxTokens = Number(maxTokensInput);

  const nextConfig = params.config;
  const noteAgentModel = async (model: string) => {
    if (!params.agentId) {
      return;
    }
    await params.prompter.note(
      `Default model set to ${model} for agent "${params.agentId}".`,
      "Model configured",
    );
  };

  // Apply the self-hosted OpenAI configuration
  const applied = await applyDefaultModelChoice({
    config: nextConfig,
    setDefaultModel: params.setDefaultModel,
    defaultModel: `${providerName.trim()}/${modelName.trim()}`,
    applyDefaultConfig: (cfg) =>
      applySelfHostedOpenAIProviderConfig(cfg, {
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
        modelName: modelName.trim(),
        providerName: providerName.trim(),
        reasoning,
        contextWindow,
        maxTokens,
      }),
    applyProviderConfig: (cfg) =>
      applySelfHostedOpenAIProviderConfig(cfg, {
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
        modelName: modelName.trim(),
        providerName: providerName.trim(),
        reasoning,
        contextWindow,
        maxTokens,
      }),
    noteDefault: `${providerName.trim()}/${modelName.trim()}`,
    noteAgentModel,
    prompter: params.prompter,
  });

  return {
    config: applied.config,
    agentModelOverride: applied.agentModelOverride,
  };
}
