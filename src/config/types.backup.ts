import type { SecretInput } from "./types.secrets.js";

export type BackupRetentionConfig = {
  keepDaily?: number;
  keepWeekly?: number;
  keepMonthly?: number;
  maxSnapshots?: number;
};

export type BackupEncryptionConfig = {
  key?: SecretInput;
};

export type BackupConfig = {
  /**
   * OpenClaw-owned backup directory inside a user cloud drive folder.
   * Example: ~/Library/Mobile Documents/com~apple~CloudDocs/OpenClaw Backups
   */
  target?: string;
  retention?: BackupRetentionConfig;
  encryption?: BackupEncryptionConfig;
};
