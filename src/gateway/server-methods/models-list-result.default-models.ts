import type {
  ModelsListParams,
  ModelsListResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection-config.js";
import type { UtilityCompletionRuntimeParams } from "../../agents/utility-completion.js";
import { readUtilityModelSetting } from "../../agents/utility-model-setting.js";
import {
  resolveAutomaticUtilityModelRef,
  resolveUtilityModelSelectionForAgent,
} from "../../agents/utility-model.js";
import { tryResolveLegacyCompatibilityAgentId } from "../../config/legacy.default-agent-owner.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";

/**
 * Auto utility preview from agents.defaults.model, plus the route the utility
 * model in effect (automatic or explicit) runs on.
 */
export async function resolveDefaultModelsPreview(
  params: UtilityCompletionRuntimeParams & {
    request: ModelsListParams;
    view: NonNullable<ModelsListParams["view"]>;
  },
): Promise<
  | {
      defaultModels: NonNullable<ModelsListResult["defaultModels"]>;
      utilityModel?: NonNullable<ModelsListResult["utilityModel"]>;
    }
  | undefined
> {
  const { request, view } = params;
  if (
    !(
      request.includeDefaultModels ??
      (view === "configured" && !request.sessionKey && !request.authProfileId)
    )
  ) {
    return undefined;
  }
  const includeAgentUtilityModel =
    request.includeDefaultModels === true && !request.sessionKey && !request.authProfileId;
  const { cfg, metadataSnapshot, snapshot: catalog } = params;
  const utilityModel: NonNullable<ModelsListResult["utilityModel"]> =
    resolveUtilityModelSelectionForAgent({
      cfg,
      agentId: params.agentId,
      catalog,
      metadataSnapshot,
    }) ?? {
      modelRef: null,
      source:
        readUtilityModelSetting(cfg, params.agentId).kind === "disabled" ? "disabled" : "none",
    };
  const primary = resolveDefaultModelForAgent({
    cfg,
    manifestPlugins: metadataSnapshot,
    allowPluginNormalization: false,
  });
  const automaticUtilityModel =
    resolveAutomaticUtilityModelRef({
      cfg,
      primaryProvider: primary.provider,
      primaryModelRef: resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model),
      primaryModelId: primary.model,
      catalog,
      metadataSnapshot,
    }) ?? null;
  // The picker shows the defaults for all agents, so report a route only for a sole
  // agent that runs exactly that setting: its own override would describe another model.
  const agentId = tryResolveLegacyCompatibilityAgentId(cfg);
  const defaults = readUtilityModelSetting(cfg);
  const effective = agentId ? readUtilityModelSetting(cfg, agentId) : undefined;
  if (
    !agentId ||
    agentId !== params.agentId ||
    !effective ||
    effective.kind !== defaults.kind ||
    effective.kind === "disabled" ||
    (effective.kind === "explicit" &&
      defaults.kind === "explicit" &&
      effective.modelRef !== defaults.modelRef) ||
    (effective.kind === "auto" &&
      (!automaticUtilityModel || utilityModel.modelRef !== automaticUtilityModel))
  ) {
    return {
      defaultModels: { automaticUtilityModel },
      ...(includeAgentUtilityModel ? { utilityModel } : {}),
    };
  }
  const { resolveUtilityCompletionRuntimeForAgent } =
    await import("../../agents/utility-completion.js");
  const utilityRuntime = await resolveUtilityCompletionRuntimeForAgent({
    ...params,
    agentId,
  });
  return {
    defaultModels: { automaticUtilityModel, ...(utilityRuntime ? { utilityRuntime } : {}) },
    ...(includeAgentUtilityModel ? { utilityModel } : {}),
  };
}
