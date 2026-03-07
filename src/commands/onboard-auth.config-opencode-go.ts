import {
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_DEFAULT_MODEL_REF,
  OPENCODE_GO_MODEL_CATALOG,
} from "../agents/opencode-go-models.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
} from "./onboard-auth.config-shared.js";

export function applyOpencodeGoProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[OPENCODE_GO_DEFAULT_MODEL_REF] = {
    ...models[OPENCODE_GO_DEFAULT_MODEL_REF],
    alias: models[OPENCODE_GO_DEFAULT_MODEL_REF]?.alias ?? "Kimi",
  };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "opencode-go",
    api: "openai-completions",
    baseUrl: OPENCODE_GO_BASE_URL,
    catalogModels: [...OPENCODE_GO_MODEL_CATALOG],
  });
}

export function applyOpencodeGoConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = applyOpencodeGoProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, OPENCODE_GO_DEFAULT_MODEL_REF);
}
