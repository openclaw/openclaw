import type {
  ModelsListResult,
  ProviderPresentation,
} from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveProviderPresentation } from "../provider-presentation.js";

/** Apply current presentation after model visibility policy, not to inference catalogs. */
export function projectModelsProviderPresentation(
  result: ModelsListResult,
  cfg: OpenClawConfig,
  includeConfiguredProviders = false,
): ModelsListResult {
  // Rows carry their provider plugin's declared label; the user's configured name replaces it.
  const declaredNames = new Map<string, string>();
  for (const model of result.models) {
    if (model.providerName && !declaredNames.has(model.provider)) {
      declaredNames.set(model.provider, model.providerName);
    }
  }
  const providerIds = new Set(result.models.map((model) => model.provider));
  if (includeConfiguredProviders) {
    for (const provider of Object.keys(cfg.models?.providers ?? {})) {
      providerIds.add(provider);
    }
  }
  const presentations: Array<[string, ProviderPresentation]> = [];
  for (const provider of providerIds) {
    const configured = resolveProviderPresentation(cfg, provider);
    const providerName = configured.providerName ?? declaredNames.get(provider);
    const presentation = { ...configured, ...(providerName ? { providerName } : {}) };
    if (presentation.providerName || presentation.providerIcon) {
      presentations.push([provider, presentation]);
    }
  }
  if (presentations.length === 0) {
    return result;
  }
  const providerPresentations = Object.fromEntries(presentations);
  return {
    ...result,
    providerPresentations,
    models: result.models.map((model) => ({
      ...model,
      ...providerPresentations[model.provider],
    })),
  };
}
