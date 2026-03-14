import { findModelInCatalog, loadModelCatalog } from "../../agents/model-catalog.js";
import { writeConfigFile } from "../../config/config.js";
import { logConfigUpdated } from "../../config/logging.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  applyDefaultModelPrimaryUpdate,
  loadValidConfigOrThrow,
  resolveModelTarget,
} from "./shared.js";

export async function modelsSetCommand(modelRaw: string, runtime: RuntimeEnv) {
  const cfg = await loadValidConfigOrThrow();
  const resolved = resolveModelTarget({ raw: modelRaw, cfg });

  // Warn when model is not in catalog (typo, stale catalog, or custom provider).
  // Not a hard error — runtime trusts allowlist entries even without catalog match.
  const catalog = await loadModelCatalog({ config: cfg });
  if (catalog.length > 0) {
    if (!findModelInCatalog(catalog, resolved.provider, resolved.model)) {
      const key = `${resolved.provider}/${resolved.model}`;
      runtime.log(
        `Warning: "${key}" not found in model catalog. This may be a typo. Run "openclaw models list" to see available models.`,
      );
    }
  }

  const updated = applyDefaultModelPrimaryUpdate({ cfg, modelRaw, field: "model" });
  await writeConfigFile(updated);

  logConfigUpdated(runtime);
  runtime.log(
    `Default model: ${resolveAgentModelPrimaryValue(updated.agents?.defaults?.model) ?? modelRaw}`,
  );
}
