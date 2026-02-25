import type { OpenClawConfig } from "../../config/config.js";
import type { ConfigWriteOptions } from "../../config/io.js";

export type MigrationCounters = {
  configRefs: number;
  authProfileRefs: number;
  plaintextRemoved: number;
  secretsWritten: number;
  envEntriesRemoved: number;
  authStoresChanged: number;
};

export type AuthStoreChange = {
  path: string;
  nextStore: Record<string, unknown>;
};

export type EnvChange = {
  path: string;
  nextRaw: string;
};

export type BackupManifestEntry = {
  path: string;
  existed: boolean;
  backupPath?: string;
  mode?: number;
};

export type BackupManifest = {
  version: 1;
  backupId: string;
  createdAt: string;
  entries: BackupManifestEntry[];
};

export type MigrationPlan = {
  changed: boolean;
  counters: MigrationCounters;
  stateDir: string;
  configChanged: boolean;
  nextConfig: OpenClawConfig;
  configWriteOptions: ConfigWriteOptions;
  authStoreChanges: AuthStoreChange[];
  payloadChanged: boolean;
  nextPayload: Record<string, unknown>;
  secretsFilePath: string;
  secretsFileTimeoutMs: number;
  sopsConfigPath?: string;
  envChange: EnvChange | null;
  backupTargets: string[];
};

export type SecretsMigrationRunOptions = {
  write?: boolean;
  scrubEnv?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: Date;
};

export type SecretsMigrationRunResult = {
  mode: "dry-run" | "write";
  changed: boolean;
  backupId?: string;
  backupDir?: string;
  secretsFilePath: string;
  counters: MigrationCounters;
  changedFiles: string[];
};

export type SecretsMigrationRollbackOptions = {
  backupId: string;
  env?: NodeJS.ProcessEnv;
};

export type SecretsMigrationRollbackResult = {
  backupId: string;
  restoredFiles: number;
  deletedFiles: number;
};
