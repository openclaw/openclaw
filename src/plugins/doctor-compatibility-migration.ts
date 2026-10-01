import { cloneConfigWithResolutionFacts } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { PluginDoctorCompatibilityNormalizer } from "./doctor-contract-module.js";

/** Compatibility hooks transform a private candidate; state migration admission stays separate. */
export function applyPluginDoctorCompatibilityMigration(params: {
  pluginId: string;
  config: OpenClawConfig;
  normalize: PluginDoctorCompatibilityNormalizer;
}): { config: OpenClawConfig; changes: string[]; warnings?: string[] } {
  const candidate = cloneConfigWithResolutionFacts(params.config);
  try {
    const mutation = params.normalize({ cfg: candidate });
    return mutation?.changes.length ? mutation : { config: params.config, changes: [] };
  } catch (error) {
    return {
      config: params.config,
      changes: [],
      warnings: [
        `Plugin "${params.pluginId}" config repair failed: ${formatErrorMessage(error)}. Its config was preserved; run \`openclaw doctor --fix\` after repairing the plugin.`,
      ],
    };
  }
}
