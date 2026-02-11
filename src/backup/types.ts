/**
 * Backup/restore types and interfaces.
 *
 * @module backup/types
 */

/** Components that can be backed up. */
export type BackupComponent =
  | "config"
  | "workspace"
  | "cron"
  | "skills"
  | "sessions"
  | "approvals"
  | "pairing";

export const ALL_BACKUP_COMPONENTS: readonly BackupComponent[] = [
  "config",
  "workspace",
  "cron",
  "skills",
  "sessions",
  "approvals",
  "pairing",
] as const;

export const CORE_BACKUP_COMPONENTS: readonly BackupComponent[] = [
  "config",
  "workspace",
  "cron",
  "skills",
] as const;

/** Archive entry metadata inside the manifest. */
export type ManifestEntry = {
  /** Relative path inside the archive. */
  path: string;
  /** SHA-256 checksum of the file. */
  sha256: string;
  /** Size in bytes. */
  size: number;
};

/** Backup manifest stored as `manifest.json` inside every archive. */
export type BackupManifest = {
  /** Schema version for forward compatibility. */
  version: 1;
  /** ISO-8601 timestamp when the backup was created. */
  createdAt: string;
  /** OpenClaw version that produced this backup. */
  openclawVersion: string;
  /** Which components are included. */
  components: BackupComponent[];
  /** Per-file metadata for integrity verification. */
  entries: ManifestEntry[];
  /** Optional human-readable label. */
  label?: string;
  /** If true, the archive payload is encrypted. */
  encrypted?: boolean;
};

/** Options for `backup export`. */
export type ExportOptions = {
  /** Output file path or S3 URL. */
  output: string;
  /** Components to include (default: core). */
  components?: BackupComponent[];
  /** For incremental session export: ISO-8601 or duration string. */
  since?: string;
  /** Human label stored in manifest. */
  label?: string;
  /** Encrypt with passphrase. */
  encrypt?: string;
};

/** Options for `backup import` / `backup restore`. */
export type ImportOptions = {
  /** Input file path or S3 URL. */
  input: string;
  /** Merge cron jobs instead of replacing. */
  merge?: boolean;
  /** Show what would be restored without applying. */
  dryRun?: boolean;
  /** Decrypt passphrase. */
  decrypt?: string;
};

/** Options for `backup list`. */
export type ListOptions = {
  /** Storage backend to query (local dir or S3 prefix). */
  storage?: string;
};

/** A stored backup entry returned by `list`. */
export type BackupEntry = {
  /** Unique identifier (filename or S3 key). */
  id: string;
  /** When the backup was created. */
  createdAt: string;
  /** Size in bytes. */
  size: number;
  /** Components included. */
  components: BackupComponent[];
  /** Human label. */
  label?: string;
  /** Whether the archive is encrypted. */
  encrypted?: boolean;
};

// ---------------------------------------------------------------------------
// Storage backend interface
// ---------------------------------------------------------------------------

/** Abstract storage backend for backup archives. */
export type StorageBackend = {
  /** Write a file to storage. */
  put(key: string, data: Buffer | Uint8Array): Promise<void>;
  /** Read a file from storage. */
  get(key: string): Promise<Buffer>;
  /** List stored backups (newest first). */
  list(): Promise<BackupEntry[]>;
  /** Delete a specific backup. */
  delete(key: string): Promise<void>;
  /** Check if a key exists. */
  exists(key: string): Promise<boolean>;
};

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export type BackupStorageType = "local" | "s3";

export type BackupStorageConfig = {
  type: BackupStorageType;
  /** Local: directory path. S3: bucket name. */
  path?: string;
  /** S3 only: bucket prefix. */
  prefix?: string;
  /** S3 only: region. */
  region?: string;
  /** S3 only: endpoint (for R2, MinIO, GCS). */
  endpoint?: string;
  /** S3 only: access key. */
  accessKeyId?: string;
  /** S3 only: secret key. */
  secretAccessKey?: string;
};

export type BackupRetentionConfig = {
  /** Keep N daily backups. */
  daily?: number;
  /** Keep N weekly backups. */
  weekly?: number;
  /** Keep N monthly backups. */
  monthly?: number;
};

export type BackupEncryptionConfig = {
  enabled?: boolean;
  /** KMS key ARN or passphrase hint. */
  keyId?: string;
};

export type BackupConfig = {
  /** Enable scheduled backups. */
  enabled?: boolean;
  /** Cron expression for auto-backups. */
  schedule?: string;
  /** Storage backend settings. */
  storage?: BackupStorageConfig;
  /** Retention policy. */
  retention?: BackupRetentionConfig;
  /** Encryption settings. */
  encryption?: BackupEncryptionConfig;
};
