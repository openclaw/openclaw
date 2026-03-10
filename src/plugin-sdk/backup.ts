// Narrow plugin-sdk surface for backup extension plugins.
// Keep this list additive and scoped to symbols needed by backup-related plugins
// (e.g. extensions/backup-encrypt).

export {
  buildBackupArchiveBasename,
  buildBackupArchiveRoot,
  resolveBackupPlanFromDisk,
} from "../commands/backup-shared.js";
export type {
  BackupAsset,
  BackupAssetKind,
  BackupPlan,
  BackupSkipReason,
  SkippedBackupAsset,
} from "../commands/backup-shared.js";
export type {
  BackupCreateOptions,
  BackupCreateResult,
} from "../commands/backup.js";
