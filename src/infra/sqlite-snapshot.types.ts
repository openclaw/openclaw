import type { BigIntStats } from "node:fs";
import type { BackupProgressInfo, DatabaseSync } from "node:sqlite";
import type { FileIdentityStat } from "@openclaw/fs-safe/advanced";
import type { SqliteIntegrityCheckOptions } from "./sqlite-integrity.js";
import type { SqliteFileContent } from "./sqlite-snapshot-file.js";

export type SqliteSnapshotValidator = (database: DatabaseSync, databaseLabel: string) => void;

export type CreateVerifiedSqliteSnapshotOptions = {
  sourcePath: string;
  targetPath: string;
  /** Only in an isolated child: acquire and consume a fresh private image, including crash recovery. */
  sourceAcquisition?: {
    mode: "isolated-process";
    stagingRoot: string;
    preserveSourceArtifacts?: boolean;
  };
  onProgress?: (progress: BackupProgressInfo) => void;
  /** Final caller checks around publication; failures remove only this helper's target. */
  afterPublish?: (guard: PublishedSqliteFileGuard) => void;
  beforePublish?: () => void | Promise<void>;
  requireNonEmptySource?: boolean;
  /** Skip compaction/ID rewriting; transforms may still change IDs and free-page data remains. */
  preserveRowIds?: boolean;
  /** Migration checkpoints may check only the declared rewrite scope; backups default to full. */
  integrity?: SqliteIntegrityCheckOptions;
  transform?: (database: DatabaseSync) => void | Promise<void>;
  validate?: SqliteSnapshotValidator;
};

export type PublishedSqliteFileGuard = {
  assertTargetMatchesExpectedContent: (finalCheck?: () => void) => void;
  /** Ephemeral hash binding; consumers must still match the complete fingerprint and link count. */
  assertTargetUnchanged: (finalCheck?: () => void) => {
    stat: BigIntStats;
    content: SqliteFileContent;
  };
};

export type PublishVerifiedSqliteFileOptions = {
  /** Existing targets are replaced only under retained offline custody. */
  replaceExisting?: {
    expectedIdentity: FileIdentityStat;
    expectedContent: SqliteFileContent;
    assertCustody: () => void;
  };
  sourceIdentity: FileIdentityStat;
  sourcePath: string;
  targetPath: string;
  expectedContent: SqliteFileContent;
  requireAtomicPublication?: boolean;
  beforePublish?: () => void | Promise<void>;
  validatePublished?: (publishedPath: string) => void | Promise<void>;
  /** Runs last. Call the supplied guard after any caller-specific checks. */
  afterPublish?: (guard: PublishedSqliteFileGuard) => void;
  /** Admit a destination byte copy only when actual native cloning is unavailable. */
  beforeByteCopy?: (sizeBytes: number) => void | Promise<void>;
};

export type VerifiedSqliteSnapshot = SqliteFileContent & {
  path: string;
  userVersion: number;
};
