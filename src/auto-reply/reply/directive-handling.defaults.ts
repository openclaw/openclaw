// Default model and alias resolution for directive handling.
import {
  buildModelAliasIndex,
  type ModelAliasIndex,
  resolveDefaultModelSelectionForAgent,
} from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReplyModelSelection } from "./model-runtime-normalization.js";

/** Resolve default provider/model plus alias index for directive parsing. */
export function resolveDefaultModel(params: { cfg: OpenClawConfig; agentId?: string }): {
  defaultSelection: ReplyModelSelection;
  aliasIndex: ModelAliasIndex;
} {
  const mainModel = resolveDefaultModelSelectionForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: mainModel.ref.provider,
    agentId: params.agentId,
    allowPluginNormalization: false,
  });
  return { defaultSelection: { ...mainModel, routeResolution: "raw" }, aliasIndex };
}
