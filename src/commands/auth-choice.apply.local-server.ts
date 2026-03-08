import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { promptAndConfigureLocalServer } from "./local-server-setup.js";

export async function applyAuthChoiceLocalServer(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "local-server") {
    return null;
  }

  const { config: nextConfig, modelRef } = await promptAndConfigureLocalServer({
    cfg: params.config,
    prompter: params.prompter,
    setDefaultModel: params.setDefaultModel,
  });

  if (!params.setDefaultModel) {
    return { config: nextConfig, agentModelOverride: modelRef };
  }

  await params.prompter.note(`Default model set to ${modelRef}`, "Model configured");
  return { config: nextConfig };
}
