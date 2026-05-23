import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { semiver } from "../../../shared/semiver.js";

/**
 * Migration guard utility for doctor checks.
 *
 * Checks that have already completed their migration (recorded in
 * config.meta.lastMigrationVersion) can be skipped on subsequent runs,
 * reducing doctor --fix wall-clock time for repeat invocations.
 */

const MIGRATION_META_KEY = "lastMigrationVersion" as const;

/**
 * Returns true if the config has a recorded migration at or above the
 * given version. Use this as an early-return guard in one-time migration
 * checks.
 *
 * @example
 * ```typescript
 * if (hasCompletedMigration(cfg, "2026.5.0")) {
 *   return { changes: [], warnings: [] };
 * }
 * ```
 */
export function hasCompletedMigration(cfg: OpenClawConfig, migrationVersion: string): boolean {
  const stamped = cfg.meta?.[MIGRATION_META_KEY];
  if (!stamped || typeof stamped !== "string") {
    return false;
  }
  try {
    return semiver(stamped, migrationVersion) >= 0;
  } catch {
    return false;
  }
}

/**
 * Stamps config.meta.lastMigrationVersion after a migration check
 * completes successfully. Returns the updated config.
 */
export function stampMigration(cfg: OpenClawConfig, migrationVersion: string): OpenClawConfig {
  const current = cfg.meta?.[MIGRATION_META_KEY];
  if (current && typeof current === "string") {
    try {
      if (semiver(current, migrationVersion) >= 0) {
        return cfg;
      }
    } catch {
      // fall through to stamp
    }
  }
  return {
    ...cfg,
    meta: {
      ...(cfg.meta as Record<string, unknown>),
      [MIGRATION_META_KEY]: migrationVersion,
    },
  };
}
