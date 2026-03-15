import type { OpenClawConfig } from "../config/config.js";
import { applyAgentDefaultModelPrimary } from "./onboard-auth.config-shared.js";
import { OPENCODE_GO_DEFAULT_MODEL_REF } from "./opencode-go-model-default.js";

const OPENCODE_GO_ALIAS_DEFAULTS: Record<string, string> = {
  "opencode-go/kimi-k2.5": "Kimi",
  "opencode-go/glm-5": "GLM",
  "opencode-go/minimax-m2.5": "MiniMax",
};

export function applyOpencodeGoProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  // Use the built-in opencode-go provider from pi-ai; only seed allowlist aliases.
  const models = { ...cfg.agents?.defaults?.models };
  for (const [modelRef, alias] of Object.entries(OPENCODE_GO_ALIAS_DEFAULTS)) {
    models[modelRef] = {
      ...models[modelRef],
      alias: models[modelRef]?.alias ?? alias,
    };
  }

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
      },
    },
  };
}

export function applyOpencodeGoConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = applyOpencodeGoProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, OPENCODE_GO_DEFAULT_MODEL_REF);
}
