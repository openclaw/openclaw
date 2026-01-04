import { applyLegacyMigrations } from "./legacy.js";
import type { ClawdisConfig } from "./types.js";
import { validateConfigObject } from "./validation.js";

export function migrateLegacyConfig(raw: unknown): {
  config: ClawdisConfig | null;
  changes: string[];
} {
  const { next, changes } = applyLegacyMigrations(raw);
  if (!next) return { config: null, changes: [] };
  const validated = validateConfigObject(next);
  if (!validated.ok) {
    changes.push(
      "Migration applied, but config still invalid; fix remaining issues manually.",
    );
    return { config: null, changes };
  }
  return { config: validated.config, changes };
}
