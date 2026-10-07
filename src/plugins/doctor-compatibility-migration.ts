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
    transform?: (
      mutation: ReturnType<PluginDoctorCompatibilityNormalizer>,
    ) => ReturnType<PluginDoctorCompatibilityNormalizer>;
  }>,
): { config: OpenClawConfig; changes: string[]; warnings?: string[] } {
  let next = config;
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const { pluginId, normalizeCompatibilityConfig, transform } of entries) {
    if (!normalizeCompatibilityConfig) {
      continue;
    }
    const candidate = cloneConfigWithResolutionFacts(next);
    try {
      const normalized = normalizeCompatibilityConfig({ cfg: candidate });
      // Follow-on repairs must not publish edits the hook declined to report.
      const reported = {
        ...normalized,
        config: normalized?.changes.length ? normalized.config : next,
        changes: normalized?.changes ?? [],
      };
      const mutation = transform ? transform(reported) : reported;
      if (mutation?.changes.length) {
        next = mutation.config;
        changes.push(...mutation.changes);
      }
      warnings.push(...(mutation?.warnings ?? []));
    } catch (error) {
      warnings.push(
        `Plugin "${pluginId}" config repair failed: ${formatErrorMessage(error)}. Its config was preserved; run \`openclaw doctor --fix\` after repairing the plugin.`,
      );
    }
  }
  return { config: next, changes, ...(warnings.length ? { warnings } : {}) };
}
