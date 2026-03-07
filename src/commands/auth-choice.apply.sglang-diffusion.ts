import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { promptAndConfigureSglangDiffusion } from "./sglang-diffusion-setup.js";

export async function applyAuthChoiceSglangDiffusion(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "sglang-diffusion") {
    return null;
  }

  const { config: nextConfig, modelRef } = await promptAndConfigureSglangDiffusion({
    cfg: params.config,
    prompter: params.prompter,
    agentDir: params.agentDir,
  });

  await params.prompter.note(
    `SGLang-Diffusion configured with model ${modelRef}`,
    "Image generation configured",
  );
  return { config: nextConfig };
}
