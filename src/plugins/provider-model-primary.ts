// Resolves primary model metadata for plugin-owned providers.
import {
  normalizeAgentModelMapForConfig,
  normalizeAgentModelRefForConfig,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Applies a primary model to agent defaults while preserving model fallback metadata. */
export function applyPrimaryModel(
  cfg: OpenClawConfig,
  model: string,
  opts?: { preserveExistingPrimary?: boolean },
): OpenClawConfig {
  const normalizedModel = normalizeAgentModelRefForConfig(model);
  const models = {
    ...normalizeAgentModelMapForConfig(cfg.agents?.defaults?.models ?? {}),
  };
  models[normalizedModel] = models[normalizedModel] ?? {};

  const existingModel = cfg.agents?.defaults?.model;
  const existingPrimary =
    typeof existingModel === "string"
      ? existingModel
      : typeof existingModel === "object"
        ? existingModel?.primary
        : undefined;
  const normalizedExistingPrimary = existingPrimary
    ? normalizeAgentModelRefForConfig(existingPrimary)
    : undefined;
  const existingFallbacks =
    typeof existingModel === "object"
      ? existingModel?.fallbacks?.map(normalizeAgentModelRefForConfig)
      : undefined;
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
        model: {
          ...(existingFallbacks ? { fallbacks: existingFallbacks } : undefined),
          primary:
            opts?.preserveExistingPrimary === true
              ? (normalizedExistingPrimary ?? normalizedModel)
              : normalizedModel,
        },
      },
    },
  };
}
