import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { ensureOllamaModelPulled, promptAndConfigureOllama } from "./ollama-setup.js";
import { applyAgentDefaultModelPrimary } from "./onboard-auth.config-shared.js";

export async function applyAuthChoiceOllama(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "ollama") {
    return null;
  }

  const { config, defaultModelId } = await promptAndConfigureOllama({
    cfg: params.config,
    prompter: params.prompter,
    agentDir: params.agentDir,
  });

  // Set an Ollama default so the model picker pre-selects an Ollama model.
  const defaultModel = `ollama/${defaultModelId}`;
  const configWithDefault = applyAgentDefaultModelPrimary(config, defaultModel);

  if (!params.setDefaultModel) {
    // Defer pulling: the interactive wizard will show a model picker next,
    // so avoid downloading a model the user may not choose.
    return { config, agentModelOverride: defaultModel };
  }

  await ensureOllamaModelPulled({ config: configWithDefault, prompter: params.prompter });

  return { config: configWithDefault };
}
