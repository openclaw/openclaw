// Shared migration-provider helpers for plan/apply item bookkeeping.

import type {
  MigrationDetection,
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
  MigrationProviderPlugin,
  MigrationSummary,
} from "../plugins/types.js";

export type {
  MigrationDetection,
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
  MigrationProviderPlugin,
  MigrationSummary,
};

export const MIGRATION_REASON_MISSING_SOURCE_OR_TARGET = "missing source or target";
export const MIGRATION_REASON_TARGET_EXISTS = "target exists";

export function createMigrationItem(
  params: Omit<MigrationItem, "status"> & { status?: MigrationItem["status"] },
): MigrationItem {
  return {
    ...params,
    status: params.status ?? "planned",
  };
}

export function markMigrationItemConflict(item: MigrationItem, reason: string): MigrationItem {
  return { ...item, status: "conflict", reason };
}

export function markMigrationItemError(item: MigrationItem, reason: string): MigrationItem {
  return { ...item, status: "error", reason };
}

export function markMigrationItemSkipped(item: MigrationItem, reason: string): MigrationItem {
  return { ...item, status: "skipped", reason };
}

export function summarizeMigrationItems(items: readonly MigrationItem[]): MigrationSummary {
  return {
    total: items.length,
    planned: items.filter((item) => item.status === "planned").length,
    migrated: items.filter((item) => item.status === "migrated").length,
    skipped: items.filter((item) => item.status === "skipped").length,
    conflicts: items.filter((item) => item.status === "conflict").length,
    errors: items.filter((item) => item.status === "error").length,
    sensitive: items.filter((item) => item.sensitive).length,
  };
}
