import { createHash } from "node:crypto";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/index.js";
import type { PluginRequesterModelCatalog } from "../../plugins/model-catalog.types.js";

/** Allowlist, not a spread: credential locators and future Gateway fields cannot leak. */
export function projectRequesterModelCatalog(
  result: ModelsListResult,
  pending = false,
): PluginRequesterModelCatalog {
  const projection: Omit<PluginRequesterModelCatalog, "revision"> = {
    state: pending || result.pendingProviders?.length ? "pending" : "prepared",
    // Unknown/pending and explicitly non-selectable rows are never availability evidence.
    models: result.models
      .filter((model) => model.available === true && model.manualSelectionAllowed !== false)
      .map((model) => {
        const choice: PluginRequesterModelCatalog["models"][number] = {
          id: model.id,
          provider: model.provider,
          name: model.name,
        };
        if (model.thinkingLevels) {
          choice.thinkingLevels = model.thinkingLevels.map((level) => level.id);
        }
        if (model.supportsFastMode !== undefined) {
          choice.fastModes = model.supportsFastMode ? [false, true, "auto"] : [false];
        }
        return choice;
      }),
    ...(result.modelSelectionPolicy
      ? {
          selectionPolicy: {
            restricted: true,
            defaultModel: result.modelSelectionPolicy.defaultModel,
          },
        }
      : {}),
  };
  return {
    revision: createHash("sha256").update(JSON.stringify(projection)).digest("hex"),
    ...projection,
  };
}
