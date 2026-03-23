import type { OpenClawConfig } from "../config/config.js";
import { ensureModelAllowlistEntry } from "./model-allowlist.js";

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

  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        models,
      },
    },
  };
}

export function applyOpenAIConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = applyOpenAIProviderConfig(cfg);
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model:
          next.agents?.defaults?.model && typeof next.agents.defaults.model === "object"
            ? {
                ...next.agents.defaults.model,
                primary: OPENAI_DEFAULT_MODEL,
              }
            : { primary: OPENAI_DEFAULT_MODEL },
      },
    },
  };
}
