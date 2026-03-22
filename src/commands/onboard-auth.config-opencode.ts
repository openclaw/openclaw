import { OPENCODE_ZEN_DEFAULT_MODEL } from "./opencode-zen-model-default.js";
import type { OpenClawConfig } from "../config/config.js";
import { applyAgentDefaultModelPrimary } from "./onboard-auth.config-shared.js";

export function applyOpencodeZenProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  // Use the built-in opencode provider from pi-ai; only seed the allowlist alias.
  const models = { ...cfg.agents?.defaults?.models };
  models[OPENCODE_ZEN_DEFAULT_MODEL] = {
    ...models[OPENCODE_ZEN_DEFAULT_MODEL],
    alias: models[OPENCODE_ZEN_DEFAULT_MODEL]?.alias ?? "Opus",
  };

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

export function applyOpencodeZenConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = applyOpencodeZenProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, OPENCODE_ZEN_DEFAULT_MODEL);
}
