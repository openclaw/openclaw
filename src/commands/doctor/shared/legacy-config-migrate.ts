import { getDeferredPluginMigrationConfigFacts } from "../../../config/deferred-plugin-migration-config.js";
// Validating legacy config migration wrapper used by doctor config flow.
import type { OpenClawConfig } from "../../../config/types.js";
import { validateConfigObjectRawWithPlugins } from "../../../config/validation.js";
import {
  applyLegacyDoctorMigrations,
  type LegacyDoctorMigrationOptions,
} from "./legacy-config-compat.js";

/** Apply legacy migrations and validate the resulting OpenClaw config shape when possible. */
export function migrateLegacyConfig(
  raw: unknown,
  options: LegacyDoctorMigrationOptions,
): {
  config: OpenClawConfig | null;
  sourceConfig?: OpenClawConfig;
  changes: string[];
  warnings?: string[];
  partiallyValid?: boolean;
} {
  const { context } = options;
  const { next, changes, warnings } = applyLegacyDoctorMigrations(raw, options);
  const diagnostics = { changes, ...(warnings?.length ? { warnings } : {}) };
  if (!next) {
    return { config: null, ...diagnostics };
  }
  const resolvedCandidate = context
    ? (applyLegacyDoctorMigrations(context.resolvedRaw, options).next ?? context.resolvedRaw)
    : next;
  // Runtime defaults create unrelated plugin entries that Doctor would then load
  // and persist. Validate repair candidates without materializing those defaults.
  const validated = validateConfigObjectRawWithPlugins(resolvedCandidate, {
    deferredPluginMigrations: getDeferredPluginMigrationConfigFacts(context?.resolvedRaw ?? raw),
  });
  if (!validated.ok) {
    changes.push("Migration applied; other validation issues remain — run doctor to review.");
    return { config: next as OpenClawConfig, ...diagnostics, partiallyValid: true };
  }
  return { config: validated.config, sourceConfig: next as OpenClawConfig, ...diagnostics };
}
