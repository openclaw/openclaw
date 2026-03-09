import {
  getOpencodeGoStaticFallbackModels,
  OPENCODE_GO_API_BASE_URL,
  OPENCODE_GO_DEFAULT_MODEL_REF,
} from "../agents/opencode-go-models.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
} from "./onboard-auth.config-shared.js";

const OPENCODE_GO_ALIAS_DEFAULTS: Record<string, string> = {
  "opencode-go/kimi-k2.5": "Kimi",
  "opencode-go/glm-5": "GLM",
  "opencode-go/minimax-m2.5": "MiniMax",
};

export function applyOpencodeGoProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = applyProviderConfigWithModelCatalog(cfg, {
    agentModels: { ...cfg.agents?.defaults?.models },
    providerId: "opencode-go",
    api: "openai-completions",
    baseUrl: OPENCODE_GO_API_BASE_URL,
    catalogModels: getOpencodeGoStaticFallbackModels(),
  });

  const models = { ...next.agents?.defaults?.models };
  for (const [modelRef, alias] of Object.entries(OPENCODE_GO_ALIAS_DEFAULTS)) {
    models[modelRef] = {
      ...models[modelRef],
      alias: models[modelRef]?.alias ?? alias,
    };
  }

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

export function applyOpencodeGoConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = applyOpencodeGoProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, OPENCODE_GO_DEFAULT_MODEL_REF);
}
