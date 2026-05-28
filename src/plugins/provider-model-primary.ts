import {
  normalizeAgentModelMapForConfig,
  normalizeAgentModelRefForConfig,
} from "../config/model-input.js";
import type { AgentModelListConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

function resolvePrimaryModel(model?: AgentModelListConfig | string): string | undefined {
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
  const model = normalizeAgentModelRefForConfig(params.model);
  const current = resolvePrimaryModel(params.cfg.agents?.defaults?.model)?.trim();
  const normalizedCurrent = current && params.legacyModels?.has(current) ? model : current;
  if (normalizedCurrent === model) {
    return { next: params.cfg, changed: false };
  }

  return {
    next: {
      ...params.cfg,
      agents: {
        ...params.cfg.agents,
        defaults: {
          ...params.cfg.agents?.defaults,
          model:
            params.cfg.agents?.defaults?.model &&
            typeof params.cfg.agents.defaults.model === "object"
              ? {
                  ...params.cfg.agents.defaults.model,
                  primary: model,
                }
              : { primary: model },
        },
      },
    },
    changed: true,
  };
}

/**
 * Derive a human-readable model name from a model id.
 * e.g. "gemini-2.5-flash" -> "Gemini 2.5 Flash"
 */
function humanizeModelId(modelId: string): string {
  return modelId
    .split("-")
    .map((word) => {
      if (/^\d/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

export function applyPrimaryModel(cfg: OpenClawConfig, model: string): OpenClawConfig {
  const normalizedModel = normalizeAgentModelRefForConfig(model);
  const defaults = cfg.agents?.defaults;
  const existingModel = defaults?.model;
  const existingModels = normalizeAgentModelMapForConfig(defaults?.models ?? {});
  const fallbacks =
    typeof existingModel === "object" && existingModel !== null && "fallbacks" in existingModel
      ? (existingModel as { fallbacks?: string[] }).fallbacks?.map((fallback) =>
          normalizeAgentModelRefForConfig(fallback),
        )
      : undefined;
  let result: OpenClawConfig = {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        model: {
          ...(fallbacks ? { fallbacks } : undefined),
          primary: normalizedModel,
        },
        models: {
          ...existingModels,
          [normalizedModel]: existingModels?.[normalizedModel] ?? {},
        },
      },
    },
  };

  // Also register the model in models.providers so the runtime model
  // resolver can find it. The wizard writes to agents.defaults.model.primary
  // but not to models.providers, causing "Unknown model" errors at runtime.
  const slashIndex = normalizedModel.indexOf("/");
  if (slashIndex > 0) {
    const providerName = normalizedModel.slice(0, slashIndex);
    const modelId = normalizedModel.slice(slashIndex + 1);
    const modelName = humanizeModelId(modelId);
    const existingProviders =
      (result.models as Record<string, unknown> | undefined)?.providers ?? {};
    const existingProvider =
      (existingProviders as Record<string, Record<string, unknown>>)[providerName] ?? {};
    const existingProviderModels = Array.isArray(existingProvider.models)
      ? (existingProvider.models as Array<{ id?: string }>)
      : [];
    const alreadyRegistered = existingProviderModels.some((m) => m.id === modelId);
    if (!alreadyRegistered) {
      const updatedProviders = {
        ...(existingProviders as Record<string, unknown>),
        [providerName]: {
          ...existingProvider,
          models: [...existingProviderModels, { id: modelId, name: modelName }],
        },
      };
      result = {
        ...result,
        models: {
          ...result.models,
          providers: updatedProviders,
        } as OpenClawConfig["models"],
      };
    }
  }

  return result;
}
