import { logConfigUpdated } from "../../config/logging.js";
import type { RuntimeEnv } from "../../runtime.js";
import { applyDefaultModelPrimaryUpdate, updateConfig } from "./shared.js";
import { validateModelAgainstCatalog } from "./validate-model.js";

export async function modelsSetImageCommand(modelRaw: string, runtime: RuntimeEnv) {
  // Validate against the model catalog before saving.
  const validation = await validateModelAgainstCatalog(modelRaw);
  if (!validation.valid) {
    runtime.log(validation.message);
    throw new Error(`Invalid model: ${modelRaw}`);
  }

  const updated = await updateConfig((cfg) => {
    return applyDefaultModelPrimaryUpdate({ cfg, modelRaw, field: "imageModel" });
  });

  logConfigUpdated(runtime);
  runtime.log(`Image model: ${updated.agents?.defaults?.imageModel?.primary ?? modelRaw}`);
}
