import type { ActiveMediaModel } from "../../../packages/media-understanding-common/src/active-model.js";
import { findModelInCatalog } from "../../agents/model-catalog-lookup.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { ModelRef } from "../../agents/model-ref-shared.js";
import { resolveModelRefFromString } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { extractModelDirective } from "../model.js";

/** With no configured or selected model, only a `/model` pick in this message names one. */
export function pickUnconfiguredTurnModel(
  cfg: OpenClawConfig,
  agentId: string,
  body: string,
  defaultProvider: string,
  aliasIndex: Parameters<typeof resolveModelRefFromString>[0]["aliasIndex"],
): ModelRef | undefined {
  const raw = extractModelDirective(body).rawModel;
  return raw
    ? resolveModelRefFromString({ cfg, agentId, raw, defaultProvider, aliasIndex })?.ref
    : undefined;
}

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
