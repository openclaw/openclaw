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
  const providerIds = new Set(result.models.map((model) => model.provider));
  if (includeConfiguredProviders) {
    for (const provider of Object.keys(cfg.models?.providers ?? {})) {
      providerIds.add(provider);
    }
  }
  const presentations: Array<[string, ProviderPresentation]> = [];
  for (const provider of providerIds) {
    const presentation = resolveProviderPresentation(cfg, provider);
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
