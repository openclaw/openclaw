import type { OpenClawConfig } from "../config/config.js";
import { ensureModelAllowlistEntry } from "./model-allowlist.js";
// @see src/commands/model-default.ts for patchAgentDefaults and patchAgentDefaultModel
import { patchAgentDefaultModel, patchAgentDefaults } from "./model-default.js";

export const OPENAI_DEFAULT_MODEL = "openai/gpt-5.1-codex";

export function applyOpenAIProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = ensureModelAllowlistEntry({
    cfg,
    modelRef: OPENAI_DEFAULT_MODEL,
  });
  const models = { ...next.agents?.defaults?.models };
  models[OPENAI_DEFAULT_MODEL] = {
    ...models[OPENAI_DEFAULT_MODEL],
    alias: models[OPENAI_DEFAULT_MODEL]?.alias ?? "GPT",
  };

  return patchAgentDefaults(next, { models });
}

export function applyOpenAIConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = applyOpenAIProviderConfig(cfg);
  return patchAgentDefaultModel(next, { primary: OPENAI_DEFAULT_MODEL });
}
