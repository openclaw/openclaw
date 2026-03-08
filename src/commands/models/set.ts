import { findModelInCatalog, loadModelCatalog } from "../../agents/model-catalog.js";
import type { OpenClawConfig } from "../../config/config.js";
import { readConfigFileSnapshot, writeConfigFile } from "../../config/config.js";
import { logConfigUpdated } from "../../config/logging.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { RuntimeEnv } from "../../runtime.js";
import { applyDefaultModelPrimaryUpdate, resolveModelTarget } from "./shared.js";

export async function modelsSetCommand(modelRaw: string, runtime: RuntimeEnv) {
  // Read config once — used for validation, catalog check, and the final write
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    const issues = snapshot.issues.map((i) => `- ${i.path}: ${i.message}`).join("\n");
    throw new Error(`Invalid config at ${snapshot.path}\n${issues}`);
  }
  const cfg: OpenClawConfig = snapshot.config;
  const resolved = resolveModelTarget({ raw: modelRaw, cfg });

  // Validate against catalog (skip when catalog is empty — initial setup)
  const catalog = await loadModelCatalog({ config: cfg });
  if (catalog.length > 0) {
    if (!findModelInCatalog(catalog, resolved.provider, resolved.model)) {
      const key = `${resolved.provider}/${resolved.model}`;
      throw new Error(
        `Unknown model: ${key}\nModel not found in catalog. Run "openclaw models list" to see available models.`,
      );
    }
  }

  // Check whether this is a new entry before mutation
  const key = `${resolved.provider}/${resolved.model}`;
  const isNewEntry = !cfg.agents?.defaults?.models?.[key];

  // Apply update and write (single config read, no TOCTOU)
  const updated = applyDefaultModelPrimaryUpdate({ cfg, modelRaw, field: "model" });
  await writeConfigFile(updated);

  if (isNewEntry) {
    runtime.log(
      `Warning: "${key}" had no entry in models config. Added with empty config (no provider routing).`,
    );
  }
  logConfigUpdated(runtime);
  runtime.log(
    `Default model: ${resolveAgentModelPrimaryValue(updated.agents?.defaults?.model) ?? modelRaw}`,
  );
}
