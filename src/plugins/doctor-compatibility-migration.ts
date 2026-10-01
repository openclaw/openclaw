import { cloneConfigWithResolutionFacts } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { PluginDoctorCompatibilityNormalizer } from "./doctor-contract-module.js";

/** Selection and order belong to callers; every hook transforms a private candidate. */
export function applyPluginDoctorCompatibilitySequence(
  config: OpenClawConfig,
  entries: Iterable<{
    pluginId: string;
    normalizeCompatibilityConfig?: PluginDoctorCompatibilityNormalizer;
  }>,
): { config: OpenClawConfig; changes: string[]; warnings?: string[] } {
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const { pluginId, normalizeCompatibilityConfig } of entries) {
    if (!normalizeCompatibilityConfig) {
      continue;
    }
    const candidate = cloneConfigWithResolutionFacts(config);
    try {
      const mutation = normalizeCompatibilityConfig({ cfg: candidate });
      if (mutation?.changes.length) {
        config = mutation.config;
        changes.push(...mutation.changes);
      }
      warnings.push(...(mutation?.warnings ?? []));
    } catch (error) {
      warnings.push(
        `Plugin "${pluginId}" config repair failed: ${formatErrorMessage(error)}. Its config was preserved; run \`openclaw doctor --fix\` after repairing the plugin.`,
      );
    }
  }
  return { config, changes, ...(warnings.length ? { warnings } : {}) };
}
