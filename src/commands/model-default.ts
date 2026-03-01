import type { OpenClawConfig } from "../config/config.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { AgentModelListConfig } from "../config/types.js";

/**
 * Canonical helper for immutably patching agents.defaults in OpenClawConfig.
 * Use this instead of manually spreading { ...cfg, agents: { ...cfg.agents, defaults: { ... } } }.
 * All command/onboarding code that sets agent default fields should call this.
 *
 * @see src/commands/model-default.ts for model-specific helpers that build on this.
 */
export function patchAgentDefaults(
  cfg: OpenClawConfig,
  patch: Partial<AgentDefaultsConfig>,
): OpenClawConfig {
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: { ...cfg.agents?.defaults, ...patch },
    },
  };
}

/**
 * Patches the model field inside agents.defaults, preserving existing model
 * object fields (like fallbacks) when the model is already an object.
 * @see patchAgentDefaults for the lower-level primitive.
 */
export function patchAgentDefaultModel(
  cfg: OpenClawConfig,
  modelPatch: Partial<AgentModelListConfig>,
): OpenClawConfig {
  const existing = cfg.agents?.defaults?.model;
  return patchAgentDefaults(cfg, {
    model: existing && typeof existing === "object" ? { ...existing, ...modelPatch } : modelPatch,
  });
}

export function resolvePrimaryModel(model?: AgentModelListConfig | string): string | undefined {
  if (typeof model === "string") {
    return model;
  }
  if (model && typeof model === "object" && typeof model.primary === "string") {
    return model.primary;
  }
  return undefined;
}

export function applyAgentDefaultPrimaryModel(params: {
  cfg: OpenClawConfig;
  model: string;
  legacyModels?: Set<string>;
}): { next: OpenClawConfig; changed: boolean } {
  const current = resolvePrimaryModel(params.cfg.agents?.defaults?.model)?.trim();
  const normalizedCurrent = current && params.legacyModels?.has(current) ? params.model : current;
  if (normalizedCurrent === params.model) {
    return { next: params.cfg, changed: false };
  }

  return {
    next: patchAgentDefaultModel(params.cfg, { primary: params.model }),
    changed: true,
  };
}
