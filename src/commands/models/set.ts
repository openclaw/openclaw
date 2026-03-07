import { logConfigUpdated } from "../../config/logging.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { RuntimeEnv } from "../../runtime.js";
import { applyDefaultModelPrimaryUpdate, resolveModelTarget, updateConfig } from "./shared.js";

export async function modelsSetCommand(modelRaw: string, runtime: RuntimeEnv) {
  // Read current model before updating
  const currentCfg = await updateConfig((cfg) => cfg);
  const oldModel = resolveAgentModelPrimaryValue(currentCfg.agents?.defaults?.model);

  // Update to new model
  const updated = await updateConfig((cfg) => {
    return applyDefaultModelPrimaryUpdate({ cfg, modelRaw, field: "model" });
  });

  // If old model exists and is different from new model, add it as fallback
  if (oldModel && oldModel !== modelRaw) {
    const resolved = resolveModelTarget({ raw: modelRaw, cfg: updated });
    const newModelKey = `${resolved.provider}/${resolved.model}`;

    // Only add old model as fallback if it's not already the primary or in fallbacks
    const modelConfig = updated.agents?.defaults?.model;
    const currentFallbacks = (modelConfig as { fallbacks?: string[] })?.fallbacks ?? [];
    if (oldModel !== newModelKey && !currentFallbacks.includes(oldModel)) {
      await updateConfig((cfg) => ({
        ...cfg,
        agents: {
          ...cfg.agents,
          defaults: {
            ...cfg.agents?.defaults,
            model: {
              ...(typeof modelConfig === "object" ? modelConfig : {}),
              fallbacks: [...currentFallbacks, oldModel],
            },
          },
        },
      }));
      runtime.log(`Old model "${oldModel}" set as fallback.`);
    }
  }

  logConfigUpdated(runtime);
  runtime.log(
    `Default model: ${resolveAgentModelPrimaryValue(updated.agents?.defaults?.model) ?? modelRaw}`,
  );
}
