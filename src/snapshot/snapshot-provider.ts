export const SNAPSHOT_MANIFEST_FILENAME = "manifest.json";
export const SNAPSHOT_SQLITE_FILENAME = "database.sqlite";

export type SnapshotDatabaseRef = {
  readonly path: string;
  readonly id?: string;
  readonly kind?: string;
  readonly sanitize?: "global-state";
};

export type SnapshotArtifact = {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
};

export type SnapshotManifest = {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly createdAt: string;
  readonly database: {
    readonly id: string;
    readonly kind?: string;
    readonly basename: string;
    readonly userVersion: number;
  };
  readonly artifact: SnapshotArtifact;
};

export type SnapshotRef = {
  readonly path: string;
};

export type SnapshotResult = {
  readonly ref: SnapshotRef;
  readonly manifest: SnapshotManifest;
};

export type SnapshotVerificationResult = {
  readonly ok: boolean;
  readonly manifest: SnapshotManifest;
  readonly integrityCheck: readonly string[];
};

export type SnapshotSummary = {
  readonly ref: SnapshotRef;
  readonly manifest: SnapshotManifest;
};

export type SqliteSnapshotProvider = {
  create(dbRef: SnapshotDatabaseRef): Promise<SnapshotResult>;
  verify(snapshotRef: SnapshotRef): Promise<SnapshotVerificationResult>;
  restore(snapshotRef: SnapshotRef, targetPath: string): Promise<SnapshotVerificationResult>;
  list?(): Promise<SnapshotSummary[]>;
};
