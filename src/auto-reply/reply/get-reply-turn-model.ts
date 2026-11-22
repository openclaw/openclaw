import type { ActiveMediaModel } from "../../../packages/media-understanding-common/src/active-model.js";
import { findModelInCatalog } from "../../agents/model-catalog-lookup.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Media understanding sees the turn's model when one is known. */
export function resolveActiveMediaModel(
  provider: string,
  model: string | undefined,
  catalog: readonly ModelCatalogEntry[] | undefined,
): ActiveMediaModel | undefined {
  return model
    ? { provider, model, api: findModelInCatalog(catalog ?? [], provider, model)?.api }
    : undefined;
}

/**
 * Whether any model source could answer this turn. A turn with none is rejected before its agent
 * run, so it must not pay for provider preprocessing such as transcription first.
 */
export function turnMayHaveModel(
  model: string | undefined,
  preprocessingState: { sessionEntry?: { modelOverride?: string } } | undefined,
  cfg: OpenClawConfig,
): boolean {
  return Boolean(
    model || preprocessingState?.sessionEntry?.modelOverride || cfg.channels?.modelByChannel,
  );
}
