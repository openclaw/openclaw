import type { OpenClawConfig } from "../config/config.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { promptAndConfigureLmStudio } from "./lmstudio-setup.js";
import { promptModelPriority } from "./local-model-utils.js";

function applyLmStudioDefaultModel(
  cfg: OpenClawConfig,
  primary: string,
  fallbacks: string[],
): OpenClawConfig {
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        model: {
          primary,
          ...(fallbacks.length > 0 ? { fallbacks } : undefined),
        },
      },
    },
  };
}

export async function applyAuthChoiceLmStudio(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "lmstudio") {
    return null;
  }

  const { config: nextConfig, modelRefs } = await promptAndConfigureLmStudio({
    cfg: params.config,
    prompter: params.prompter,
  });

  if (modelRefs.length === 0) {
    return { config: nextConfig };
  }

  // When multiple models are selected, prompt for priority configuration
  if (modelRefs.length > 1) {
    const priority = await promptModelPriority({
      prompter: params.prompter,
      modelRefs,
    });

    if (!params.setDefaultModel) {
      return { config: nextConfig, agentModelOverride: priority.primary };
    }

    // Add all selected models to the allowlist
    const models = { ...nextConfig.agents?.defaults?.models };
    for (const ref of modelRefs) {
      models[ref] = models[ref] ?? {};
    }

    const configWithModels: OpenClawConfig = {
      ...nextConfig,
      agents: {
        ...nextConfig.agents,
        defaults: {
          ...nextConfig.agents?.defaults,
          models,
        },
      },
    };

    const finalConfig = applyLmStudioDefaultModel(
      configWithModels,
      priority.primary,
      priority.fallbacks,
    );

    await params.prompter.note(
      `Primary: ${priority.primary}\n` +
        (priority.fallbacks.length > 0 ? `Fallbacks: ${priority.fallbacks.join(" → ")}\n` : "") +
        `Strategy: ${priority.strategy}`,
      "Model priority configured",
    );

    return { config: finalConfig };
  }

  // Single model — simple path
  if (!params.setDefaultModel) {
    return { config: nextConfig, agentModelOverride: modelRefs[0] };
  }

  await params.prompter.note(`Default model set to ${modelRefs[0]}`, "Model configured");
  return { config: applyLmStudioDefaultModel(nextConfig, modelRefs[0], []) };
}
