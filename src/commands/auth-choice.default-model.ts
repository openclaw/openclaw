import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { ensureModelAllowlistEntry } from "./model-allowlist.js";

export async function applyDefaultModelChoice(params: {
  config: OpenClawConfig;
  setDefaultModel: boolean;
  defaultModel: string;
  applyDefaultConfig: (config: OpenClawConfig) => OpenClawConfig;
  applyProviderConfig: (config: OpenClawConfig) => OpenClawConfig;
  noteDefault?: string;
  noteAgentModel: (model: string) => Promise<void>;
  prompter: WizardPrompter;
}): Promise<{ config: OpenClawConfig; agentModelOverride?: string }> {
  if (params.setDefaultModel) {
    const next = params.applyDefaultConfig(params.config);
    if (params.noteDefault) {
      await params.prompter.note(`Default model set to ${params.noteDefault}`, "Model configured");
    }
    return { config: next };
  }

  // When setDefaultModel is false (e.g., adding a new agent), do not override
  // the agent's model. Let it inherit from agents.defaults.model instead of
  // baking in the provider's defaultModel. See issue #24170.
  // However, if there is no inherited primary model, we must still return the
  // provider's default to avoid creating an agent with no model at all.
  const next = params.applyProviderConfig(params.config);
  const nextWithModel = ensureModelAllowlistEntry({
    cfg: next,
    modelRef: params.defaultModel,
  });
  const inheritedPrimary = resolveAgentModelPrimaryValue(params.config.agents?.defaults?.model);
  if (!inheritedPrimary) {
    return { config: nextWithModel, agentModelOverride: params.defaultModel };
  }
  return { config: nextWithModel };
}
