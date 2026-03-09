import { applyLegacyMigrations } from "./legacy.js";
import type { OpenClawConfig } from "./types.js";
import { validateConfigObjectWithPluginsInternal } from "./validation.js";

export function migrateLegacyConfig(raw: unknown): {
  config: OpenClawConfig | null;
  changes: string[];
} {
  const { next, changes } = applyLegacyMigrations(raw);
  if (!next) {
    return { config: null, changes: [] };
  }
  // Keep unknown/future keys during migration validation so startup auto-migrate
  // write-back does not drop forward-compatible config fields.
  const validated = validateConfigObjectWithPluginsInternal(next, { preserveUnknownKeys: true });
  if (!validated.ok) {
    changes.push("Migration applied, but config still invalid; fix remaining issues manually.");
    return { config: null, changes };
  }
  return { config: validated.config, changes };
}
