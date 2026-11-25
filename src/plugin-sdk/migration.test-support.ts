import type { MigrationSummary } from "../plugins/migration-provider.types.js";

export function createMigrationSummaryFixture(
  total: number,
  planned: number,
  migrated: number,
): MigrationSummary {
  return { total, planned, migrated, skipped: 0, conflicts: 0, errors: 0, sensitive: 0 };
}
