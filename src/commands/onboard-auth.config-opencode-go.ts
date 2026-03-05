import { OPENCODE_GO_DEFAULT_MODEL_REF } from "../agents/opencode-go-models.js";
import type { OpenClawConfig } from "../config/config.js";
import { applyAgentDefaultModelPrimary } from "./onboard-auth.config-shared.js";

export function applyOpencodeGoProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  // Use the built-in opencode-go provider; only seed the allowlist alias.
  const models = { ...cfg.agents?.defaults?.models };
  models[OPENCODE_GO_DEFAULT_MODEL_REF] = {
    ...models[OPENCODE_GO_DEFAULT_MODEL_REF],
    alias: models[OPENCODE_GO_DEFAULT_MODEL_REF]?.alias ?? "OpenCode Go MiniMax",
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

export function applyOpencodeGoConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = applyOpencodeGoProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, OPENCODE_GO_DEFAULT_MODEL_REF);
}
