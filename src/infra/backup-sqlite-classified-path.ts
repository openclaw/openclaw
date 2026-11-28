import path from "node:path";
import { isPathInside } from "@openclaw/fs-safe/path";
import type { BackupResourcePlan } from "../commands/backup-resource-inventory.js";
import { isTransientSqliteBackupPath } from "./backup-volatile-filter.js";
import { isAppleDoubleMetadataFile } from "./sqlite-files.js";

/** SQLite classification applies inside owned state and agent roots, outside package content. */
export function isSqliteClassifiedPath(
  resolvedSourcePath: string,
  policy: Pick<BackupResourcePlan, "stateDir" | "agentRoots" | "isPackageContent">,
): boolean {
  const withinOwnedRoot =
    isPathInside(policy.stateDir, resolvedSourcePath) ||
    policy.agentRoots.some(({ sourcePath: agentRoot }) =>
      isPathInside(agentRoot, resolvedSourcePath),
    );
  return withinOwnedRoot && !policy.isPackageContent(resolvedSourcePath);
}

/**
 * The `excluded` answers of classifyBackupSqliteSource that hold for an included
 * path before database discovery seals the inventory: names alone decide them.
 */
export function isExcludedBackupSqliteSourceName(
  sourcePath: string,
  resources: BackupResourcePlan,
): boolean {
  const resolvedSourcePath = path.resolve(sourcePath);
  return (
    isSqliteClassifiedPath(resolvedSourcePath, resources) &&
    (isTransientSqliteBackupPath(resolvedSourcePath) ||
      isAppleDoubleMetadataFile(resolvedSourcePath))
  );
}
