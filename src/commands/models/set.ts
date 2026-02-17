import { loadModelCatalog } from "../../agents/model-catalog.js";
import { modelKey } from "../../agents/model-selection.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { logConfigUpdated } from "../../config/logging.js";
import type { RuntimeEnv } from "../../runtime.js";
import { applyDefaultModelPrimaryUpdate, resolveModelTarget, updateConfig } from "./shared.js";

export async function modelsSetCommand(modelRaw: string, runtime: RuntimeEnv) {
  // 1. Read config and resolve the model reference
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    const issues = snapshot.issues.map((i) => `- ${i.path}: ${i.message}`).join("\n");
    throw new Error(`Invalid config at ${snapshot.path}\n${issues}`);
  }
  const cfg = snapshot.config;
  const resolved = resolveModelTarget({ raw: modelRaw, cfg });
  const key = `${resolved.provider}/${resolved.model}`;

  // 2. Validate against catalog (skip when catalog is empty — initial setup)
  const catalog = await loadModelCatalog({ config: cfg });
  if (catalog.length > 0) {
    const catalogKeys = new Set(catalog.map((e) => modelKey(e.provider, e.id)));
    if (!catalogKeys.has(key)) {
      throw new Error(
        `Unknown model: ${key}\nModel not found in catalog. Run "openclaw models list" to see available models.`,
      );
    }
  }

  // 3. Track whether this is a new entry
  const isNewEntry = !cfg.agents?.defaults?.models?.[key];

  // 4. Update config (using upstream's helper for the actual mutation)
  const updated = await updateConfig((c) => {
    return applyDefaultModelPrimaryUpdate({ cfg: c, modelRaw, field: "model" });
  });

  // 5. Warn and log
  if (isNewEntry) {
    runtime.log(
      `Warning: "${key}" had no entry in models config. Added with empty config (no provider routing).`,
    );
  }
  logConfigUpdated(runtime);
  runtime.log(`Default model: ${updated.agents?.defaults?.model?.primary ?? modelRaw}`);
}
