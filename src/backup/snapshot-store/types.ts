export type BackupArchiveMode = "full-host" | "config-only";

export type BackupSnapshotEnvelope = {
  schemaVersion: 1;
  snapshotId: string;
  installationId: string;
  createdAt: string;
  openclawVersion: string;
  archive: {
    format: "openclaw-backup-tar-gz";
    archiveRoot: string;
    createdAt: string;
    mode: BackupArchiveMode;
    includeWorkspace: boolean;
    verified: boolean;
    sha256: string;
    bytes: number;
  };
  encryption: {
    cipher: "aes-256-gcm";
    keyDerivation: {
      name: "scrypt";
      saltBase64Url: string;
      cost: number;
      blockSize: number;
      parallelization: number;
      maxMemoryBytes: number;
    };
    nonceBase64Url: string;
    authTagBase64Url: string;
  };
  ciphertext: {
    sha256: string;
    bytes: number;
  };
  snapshotName?: string;
};

export type BackupSnapshotListEntry = Pick<
  BackupSnapshotEnvelope,
  "snapshotId" | "installationId" | "createdAt" | "openclawVersion" | "snapshotName"
> & {
  mode: BackupArchiveMode;
  includeWorkspace: boolean;
  verified: boolean;
  archiveBytes: number;
  ciphertextBytes: number;
};

export type BackupSnapshotStore = {
  uploadSnapshot(params: {
    installationId: string;
    snapshotId: string;
    envelope: BackupSnapshotEnvelope;
    payloadPath: string;
  }): Promise<void>;
  listSnapshots(params: { installationId: string }): Promise<BackupSnapshotEnvelope[]>;
  downloadSnapshot(params: {
    installationId: string;
    snapshotId: string;
    envelopeOutputPath: string;
    payloadOutputPath: string;
  }): Promise<BackupSnapshotEnvelope>;
};
