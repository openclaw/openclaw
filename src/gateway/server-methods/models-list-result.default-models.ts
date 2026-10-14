import type { ModelsListResult } from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection-config.js";
import type { UtilityCompletionRuntimeParams } from "../../agents/utility-completion.js";
import { readUtilityModelSetting } from "../../agents/utility-model-setting.js";
import {
  resolveAutomaticUtilityModelRef,
  resolveUtilityModelRefForAgent,
} from "../../agents/utility-model.js";
import { tryResolveLegacyCompatibilityAgentId } from "../../config/legacy.default-agent-owner.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";

/**
 * Auto utility preview from agents.defaults.model, plus the route the utility
 * model in effect (automatic or explicit) runs on.
 */
export async function resolveDefaultModelsPreview(
  params: UtilityCompletionRuntimeParams,
): Promise<NonNullable<ModelsListResult["defaultModels"]>> {
  const { cfg, metadataSnapshot } = params;
  const automaticUtilityModel =
    resolveAutomaticUtilityModelRef({
      cfg,
      primaryProvider: resolveDefaultModelForAgent({
        cfg,
        manifestPlugins: metadataSnapshot,
        allowPluginNormalization: false,
      }).provider,
      primaryModelRef: resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model),
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
      (!automaticUtilityModel ||
        resolveUtilityModelRefForAgent({ cfg, agentId, metadataSnapshot }) !==
          automaticUtilityModel))
  ) {
    return { automaticUtilityModel };
  }
  const { resolveUtilityCompletionRuntimeForAgent } =
    await import("../../agents/utility-completion.js");
  const utilityRuntime = await resolveUtilityCompletionRuntimeForAgent({
    ...params,
    agentId,
  });
  return { automaticUtilityModel, ...(utilityRuntime ? { utilityRuntime } : {}) };
}
