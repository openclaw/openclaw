import { logConfigUpdated } from "../../config/logging.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { RuntimeEnv } from "../../runtime.js";
import { updateDefaultModelPrimaryConfig } from "./shared.js";

export async function modelsSetCommand(
  modelRaw: string,
  runtime: RuntimeEnv,
  field: "model" | "imageModel" = "model",
) {
  const repair =
    field === "model"
      ? (await import("../runtime-plugin-install.js")).repairModelSelectionRuntimePlugins
      : undefined;
  const { updated, warning: catalogWarning } = await updateDefaultModelPrimaryConfig({
    modelRaw,
    field,
  });
  if (catalogWarning) {
    runtime.error?.(catalogWarning);
  }
  const selectedModel =
    resolveAgentModelPrimaryValue(updated.agents?.defaults?.[field]) ?? modelRaw;
  const warnings = repair ? await repair({ cfg: updated, model: selectedModel }) : [];
  for (const warning of warnings) {
    runtime.error?.(warning);
  }

  logConfigUpdated(runtime);
  runtime.log(`${field === "model" ? "Default" : "Image"} model: ${selectedModel}`);
}
