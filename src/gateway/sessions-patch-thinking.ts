import { findModelCatalogEntry } from "../agents/model-catalog-lookup.js";
import { selectModelCatalogRuntimeEntry } from "../agents/model-catalog-view.js";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import { resolveThinkingProfile } from "../auto-reply/thinking.js";

/** Thinking levels a session patch validates against, for the route the runtime will use. */
export function resolveSessionPatchThinkingProfile(params: {
  provider: string;
  model: string;
  agentRuntime: string;
  catalog: ModelCatalogSnapshot | undefined;
}): ReturnType<typeof resolveThinkingProfile> {
  const { provider, model, agentRuntime } = params;
  const catalog = params.catalog?.entries;
  const logical = catalog
    ? findModelCatalogEntry(catalog, { provider, modelId: model })
    : undefined;
  const selected =
    logical && params.catalog
      ? selectModelCatalogRuntimeEntry({
          entry: logical,
          routeVariants: params.catalog.routeVariants,
          runtimeId: agentRuntime,
        }).entry
      : undefined;
  return resolveThinkingProfile({
    provider,
    model,
    catalog: selected ? [selected] : catalog,
    agentRuntime,
    configuredReasoning: logical?.configuredReasoning ?? logical?.reasoning,
  });
}
