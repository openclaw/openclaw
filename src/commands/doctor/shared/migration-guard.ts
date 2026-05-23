import type { OpenClawConfig } from "../../../config/types.openclaw.js";

/**
 * Migration guard utility for doctor checks.
 *
 * Checks that have already completed their migration (recorded in
 * config.meta.lastMigrationVersion) can be skipped on subsequent runs,
 * reducing doctor --fix wall-clock time for repeat invocations.
 */

const MIGRATION_META_KEY = "lastMigrationVersion";

/**
 * Simple semver-like comparison. Returns >0 if a > b, <0 if a < b, 0 if equal.
 * Supports "x.y.z" dotted triples. Non-numeric components are ignored.
 */
function compareVersions(a: string, b: string): number {
  const toParts = (s: string): number[] =>
    s.split(".").map((p) => {
      const n = Number.parseInt(p, 10);
      return Number.isNaN(n) ? 0 : n;
    });
  const pa = toParts(a);
  const pb = toParts(b);
  const maxLen = Math.max(pa.length, pb.length);
  for (let i = 0; i < maxLen; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

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
  const meta = cfg.meta as Record<string, unknown> | undefined;
  const stamped = meta?.[MIGRATION_META_KEY];
  if (typeof stamped !== "string") {
    return false;
  }
  try {
    return compareVersions(stamped, migrationVersion) >= 0;
  } catch {
    return false;
  }
}

/**
 * Stamps config.meta.lastMigrationVersion after a migration check
 * completes successfully. Returns the updated config.
 */
export function stampMigration(cfg: OpenClawConfig, migrationVersion: string): OpenClawConfig {
  const meta = cfg.meta as Record<string, unknown> | undefined;
  const current = meta?.[MIGRATION_META_KEY];
  if (typeof current === "string") {
    try {
      if (compareVersions(current, migrationVersion) >= 0) {
        return cfg;
      }
    } catch {
      // fall through to stamp
    }
  }
  return {
    ...cfg,
    meta: {
      ...((cfg.meta ?? {}) as Record<string, unknown>),
      [MIGRATION_META_KEY]: migrationVersion,
    },
  };
}
