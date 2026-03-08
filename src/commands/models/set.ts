import { logConfigUpdated } from "../../config/logging.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  applyDefaultModelPrimaryUpdate,
  syncSessionStoresForDefaultModelChange,
  updateConfig,
} from "./shared.js";

export async function modelsSetCommand(modelRaw: string, runtime: RuntimeEnv) {
  let previousConfig = null as
    | Parameters<typeof syncSessionStoresForDefaultModelChange>[0]["previousConfig"]
    | null;
  const updated = await updateConfig((cfg) => {
    previousConfig = cfg;
    return applyDefaultModelPrimaryUpdate({ cfg, modelRaw, field: "model" });
  });
  if (previousConfig) {
    await syncSessionStoresForDefaultModelChange({
      previousConfig,
      nextConfig: updated,
    });
  }

  logConfigUpdated(runtime);
  runtime.log(
    `Default model: ${resolveAgentModelPrimaryValue(updated.agents?.defaults?.model) ?? modelRaw}`,
  );
}
