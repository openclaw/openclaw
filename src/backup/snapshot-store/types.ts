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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid snapshot envelope: missing ${label}.`);
  }
  return value;
}

function readNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid snapshot envelope: missing ${label}.`);
  }
  return value;
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Invalid snapshot envelope: missing ${label}.`);
  }
  return value;
}

export function parseBackupSnapshotEnvelope(raw: string): BackupSnapshotEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Snapshot envelope is not valid JSON: ${String(error)}`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error("Invalid snapshot envelope: expected an object.");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error(
      `Invalid snapshot envelope: unsupported schemaVersion ${String(parsed.schemaVersion)}.`,
    );
  }
  if (!isRecord(parsed.archive)) {
    throw new Error("Invalid snapshot envelope: missing archive.");
  }
  if (!isRecord(parsed.encryption)) {
    throw new Error("Invalid snapshot envelope: missing encryption.");
  }
  if (!isRecord(parsed.ciphertext)) {
    throw new Error("Invalid snapshot envelope: missing ciphertext.");
  }
  if (!isRecord(parsed.encryption.keyDerivation)) {
    throw new Error("Invalid snapshot envelope: missing encryption.keyDerivation.");
  }

  const archiveMode = parsed.archive.mode;
  if (archiveMode !== "full-host" && archiveMode !== "config-only") {
    throw new Error(`Invalid snapshot envelope: unsupported archive.mode ${String(archiveMode)}.`);
  }

  return {
    schemaVersion: 1,
    snapshotId: readString(parsed.snapshotId, "snapshotId"),
    installationId: readString(parsed.installationId, "installationId"),
    createdAt: readString(parsed.createdAt, "createdAt"),
    openclawVersion: readString(parsed.openclawVersion, "openclawVersion"),
    archive: {
      format:
        readString(parsed.archive.format, "archive.format") === "openclaw-backup-tar-gz"
          ? "openclaw-backup-tar-gz"
          : (() => {
              throw new Error(
                `Invalid snapshot envelope: unsupported archive.format ${String(parsed.archive.format)}.`,
              );
            })(),
      archiveRoot: readString(parsed.archive.archiveRoot, "archive.archiveRoot"),
      createdAt: readString(parsed.archive.createdAt, "archive.createdAt"),
      mode: archiveMode,
      includeWorkspace: readBoolean(parsed.archive.includeWorkspace, "archive.includeWorkspace"),
      verified: readBoolean(parsed.archive.verified, "archive.verified"),
      sha256: readString(parsed.archive.sha256, "archive.sha256"),
      bytes: readNumber(parsed.archive.bytes, "archive.bytes"),
    },
    encryption: {
      cipher:
        readString(parsed.encryption.cipher, "encryption.cipher") === "aes-256-gcm"
          ? "aes-256-gcm"
          : (() => {
              throw new Error(
                `Invalid snapshot envelope: unsupported encryption.cipher ${String(parsed.encryption.cipher)}.`,
              );
            })(),
      keyDerivation: {
        name:
          readString(parsed.encryption.keyDerivation.name, "encryption.keyDerivation.name") ===
          "scrypt"
            ? "scrypt"
            : (() => {
                throw new Error(
                  `Invalid snapshot envelope: unsupported encryption.keyDerivation.name ${String(parsed.encryption.keyDerivation.name)}.`,
                );
              })(),
        saltBase64Url: readString(
          parsed.encryption.keyDerivation.saltBase64Url,
          "encryption.keyDerivation.saltBase64Url",
        ),
        cost: readNumber(parsed.encryption.keyDerivation.cost, "encryption.keyDerivation.cost"),
        blockSize: readNumber(
          parsed.encryption.keyDerivation.blockSize,
          "encryption.keyDerivation.blockSize",
        ),
        parallelization: readNumber(
          parsed.encryption.keyDerivation.parallelization,
          "encryption.keyDerivation.parallelization",
        ),
        maxMemoryBytes: readNumber(
          parsed.encryption.keyDerivation.maxMemoryBytes,
          "encryption.keyDerivation.maxMemoryBytes",
        ),
      },
      nonceBase64Url: readString(parsed.encryption.nonceBase64Url, "encryption.nonceBase64Url"),
      authTagBase64Url: readString(
        parsed.encryption.authTagBase64Url,
        "encryption.authTagBase64Url",
      ),
    },
    ciphertext: {
      sha256: readString(parsed.ciphertext.sha256, "ciphertext.sha256"),
      bytes: readNumber(parsed.ciphertext.bytes, "ciphertext.bytes"),
    },
    ...(typeof parsed.snapshotName === "string" && parsed.snapshotName.trim()
      ? { snapshotName: parsed.snapshotName }
      : {}),
  };
}

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
