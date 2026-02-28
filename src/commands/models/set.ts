import { logConfigUpdated } from "../../config/logging.js";
import { ModelConfigPropagator } from "../../config/model-config-propagator.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { RuntimeEnv } from "../../runtime.js";
import { applyDefaultModelPrimaryUpdate, updateConfig } from "./shared.js";

export async function modelsSetCommand(modelRaw: string, runtime: RuntimeEnv) {
  const updated = await updateConfig((cfg) => {
    return applyDefaultModelPrimaryUpdate({ cfg, modelRaw, field: "model" });
  });

  const resolvedModel =
    resolveAgentModelPrimaryValue(updated.agents?.defaults?.model) ?? modelRaw.trim();

  // Propagate the new model to all agent session stores to prevent config drift
  // across the 4 config stores (Bug #3 fix). Non-fatal: config file is already updated.
  const propagator = new ModelConfigPropagator();
  await propagator.setModel(resolvedModel, "global").catch(() => undefined);

  logConfigUpdated(runtime);
  runtime.log(`Default model: ${resolvedModel}`);
}
