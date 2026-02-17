import type { RuntimeEnv } from "../../runtime.js";
import { logConfigUpdated } from "../../config/logging.js";
import { applyDefaultModelPrimaryUpdate, updateConfig } from "./shared.js";

export async function modelsSetImageCommand(modelRaw: string, runtime: RuntimeEnv) {
  const updated = await updateConfig((cfg) => {
    return applyDefaultModelPrimaryUpdate({ cfg, modelRaw, field: "imageModel" });
  });

  logConfigUpdated(runtime);
  runtime.log(`Image model: ${updated.agents?.defaults?.imageModel?.primary ?? modelRaw}`);
}
