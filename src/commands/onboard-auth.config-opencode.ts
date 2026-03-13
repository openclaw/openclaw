import { OPENCODE_ZEN_DEFAULT_MODEL_REF } from "../agents/opencode-zen-models.js";
import type { OpenClawConfig } from "../config/config.js";
import { applyAgentDefaultModelPrimary } from "./onboard-auth.config-shared.js";

export function applyOpencodeZenProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  // Use the built-in opencode provider from pi-ai; only seed the allowlist alias.
  const models = { ...cfg.agents?.defaults?.models };
  models[OPENCODE_ZEN_DEFAULT_MODEL_REF] = {
    ...models[OPENCODE_ZEN_DEFAULT_MODEL_REF],
    alias: models[OPENCODE_ZEN_DEFAULT_MODEL_REF]?.alias ?? "Opus",
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
  return applyAgentDefaultModelPrimary(next, OPENCODE_ZEN_DEFAULT_MODEL_REF);
}
