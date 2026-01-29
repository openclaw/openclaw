import {
  discoverOllamaModels,
} from "../agents/models-config.providers.js";
import {
  applyAuthProfileConfig,
  applyOllamaConfig,
  applyOllamaProviderConfig,
  setOllamaApiKey,
} from "./onboard-auth.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";

export async function applyAuthChoiceOllama(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "ollama") return null;

  let nextConfig = params.config;
  let agentModelOverride: string | undefined;

  const models = await discoverOllamaModels();

  if (models.length === 0) {
    await params.prompter.note(
      [
        "Ollama was not detected or has no models installed.",
        "To use Ollama locally:",
        "1. Install Ollama from https://ollama.com",
        "2. Run `ollama serve`",
        "3. Pull a model, e.g., `ollama pull llama3` or `ollama pull deepseek-r1`.",
      ].join("\n"),
      "Ollama not found",
    );
    const continueAnyway = await params.prompter.confirm({
      message: "Configure Ollama anyway?",
      initialValue: false,
    });
    if (!continueAnyway) return { config: nextConfig };
  }

  // Set a dummy API key to enable the provider
  await setOllamaApiKey("local", params.agentDir);

  nextConfig = applyAuthProfileConfig(nextConfig, {
    profileId: "ollama:default",
    provider: "ollama",
    mode: "api_key",
  });

  if (models.length > 0) {
    const modelOptions = models.map((m) => ({
      value: `ollama/${m.id}`,
      label: m.id,
      hint: m.reasoning ? "reasoning" : undefined,
    }));

    const selectedModel = await params.prompter.select({
      message: "Select default Ollama model",
      options: modelOptions,
      initialValue: modelOptions[0]?.value,
    });

    if (selectedModel) {
      const modelRef = String(selectedModel);
      nextConfig = applyOllamaConfig(nextConfig, modelRef, models);
      agentModelOverride = modelRef;
      await params.prompter.note(
        `Default model set to ${modelRef}.`,
        "Model configured",
      );
    }
  } else {
    nextConfig = applyOllamaProviderConfig(nextConfig);
    await params.prompter.note(
      "Ollama configured. Once you pull models, they will be discoverable.",
      "Ollama configured",
    );
  }

  return { config: nextConfig, agentModelOverride };
}
