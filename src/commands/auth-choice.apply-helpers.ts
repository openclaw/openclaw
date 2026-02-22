import type { ApplyAuthChoiceParams } from "./auth-choice.apply.js";

export function createAuthChoiceAgentModelNoter(
  params: ApplyAuthChoiceParams,
): (model: string) => Promise<void> {
  return async (model: string) => {
    if (!params.agentId) {
      return;
    }
    await params.prompter.note(
      `Default model set to ${model} for agent "${params.agentId}".`,
      "Model configured",
    );
  };
}
