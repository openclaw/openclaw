import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveSnapshotStoreConfig,
  resolveSnapshotStoreTargetConfig,
  type ResolvedSnapshotStoreConfig,
  type ResolvedSnapshotStoreTargetConfig,
} from "../backup/snapshot-store/config.js";
import { resolveInstallationId } from "../backup/snapshot-store/installation-id.js";
import { createSnapshotStore, createSnapshotListStore } from "../backup/snapshot-store/provider.js";
import type {
  BackupSnapshotEnvelope,
  BackupSnapshotListEntry,
  BackupSnapshotListStore,
  BackupSnapshotStore,
} from "../backup/snapshot-store/types.js";
import { resolveStateDir, readConfigFileSnapshot } from "../config/config.js";
import { resolveRuntimeServiceVersion } from "../version.js";

export type BackupSnapshotDeps = {
  storage?: BackupSnapshotStore;
  nowMs?: number;
};

export async function loadResolvedSnapshotBackup(params: { env?: NodeJS.ProcessEnv }): Promise<{
  snapshotStore: ResolvedSnapshotStoreConfig;
  stateDir: string;
}> {
  const snapshot = await readConfigFileSnapshot();
  // Use best-effort config even when unrelated sections are invalid;
  // resolveSnapshotStoreConfig will still validate backup-specific fields.
  return {
    snapshotStore: await resolveSnapshotStoreConfig({
      config: snapshot.config,
      env: params.env ?? process.env,
    }),
    stateDir: resolveStateDir(params.env ?? process.env),
  };
}

/**
 * Resolve only the backup target directory and state dir, without requiring
 * the encryption key. Used by read-only commands (e.g. backup list) that
 * only read envelope metadata.
 */
export async function loadResolvedSnapshotBackupTarget(params: {
  env?: NodeJS.ProcessEnv;
}): Promise<{
  snapshotStore: ResolvedSnapshotStoreTargetConfig;
  stateDir: string;
}> {
  const snapshot = await readConfigFileSnapshot();
  // Use best-effort config even when unrelated sections are invalid;
  // resolveSnapshotStoreTargetConfig will still validate backup-specific fields.
  return {
    snapshotStore: await resolveSnapshotStoreTargetConfig({
      config: snapshot.config,
      env: params.env ?? process.env,
    }),
    stateDir: resolveStateDir(params.env ?? process.env),
  };
}

export async function resolveSnapshotStore(params: {
  snapshotStore: ResolvedSnapshotStoreConfig;
  deps?: BackupSnapshotDeps;
}): Promise<BackupSnapshotStore> {
  return params.deps?.storage ?? createSnapshotStore(params.snapshotStore);
}

export async function resolveSnapshotListStore(params: {
  snapshotStore: ResolvedSnapshotStoreTargetConfig;
  deps?: BackupSnapshotDeps;
}): Promise<BackupSnapshotListStore> {
  return params.deps?.storage ?? createSnapshotListStore(params.snapshotStore);
}

export async function resolveCurrentInstallationId(params: {
  stateDir: string;
  createIfMissing?: boolean;
}): Promise<string | undefined> {
  return await resolveInstallationId({
    stateDir: params.stateDir,
    createIfMissing: params.createIfMissing,
  });
}

export function createSnapshotId(nowMs = Date.now()): string {
  const timestamp = new Date(nowMs).toISOString().replace(/[:.]/g, "-");
  return `snap_${timestamp}_${randomUUID().slice(0, 8)}`;
}

export async function createTempBackupDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-snapshot-backup-"));
}

export function toSnapshotListEntry(envelope: BackupSnapshotEnvelope): BackupSnapshotListEntry {
  return {
    snapshotId: envelope.snapshotId,
    installationId: envelope.installationId,
    createdAt: envelope.createdAt,
    openclawVersion: envelope.openclawVersion,
    snapshotName: envelope.snapshotName,
    mode: envelope.archive.mode,
    includeWorkspace: envelope.archive.includeWorkspace,
    verified: envelope.archive.verified,
    archiveBytes: envelope.archive.bytes,
    ciphertextBytes: envelope.ciphertext.bytes,
  };
}

export function buildEnvelope(params: {
  snapshotId: string;
  installationId: string;
  createdAt: string;
  archiveRoot: string;
  archiveCreatedAt: string;
  includeWorkspace: boolean;
  verified: boolean;
  onlyConfig: boolean;
  snapshotName?: string;
  encryption: Pick<BackupSnapshotEnvelope, "archive" | "ciphertext" | "encryption">;
}): BackupSnapshotEnvelope {
  return {
    schemaVersion: 1,
    snapshotId: params.snapshotId,
    installationId: params.installationId,
    createdAt: params.createdAt,
    openclawVersion: resolveRuntimeServiceVersion(),
    archive: {
      ...params.encryption.archive,
      archiveRoot: params.archiveRoot,
      createdAt: params.archiveCreatedAt,
      mode: params.onlyConfig ? "config-only" : "full-host",
      includeWorkspace: params.includeWorkspace,
      verified: params.verified,
    },
    ciphertext: params.encryption.ciphertext,
    encryption: params.encryption.encryption,
    ...(params.snapshotName ? { snapshotName: params.snapshotName } : {}),
  };
}
