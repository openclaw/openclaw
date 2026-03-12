export type BackupArchiveMode = "full-host" | "config-only";

const MIN_SCRYPT_COST = 1 << 10;
const MAX_SCRYPT_COST = 1 << 17; // lowered from 2^20 to limit attacker-controlled DoS
const MIN_SCRYPT_BLOCK_SIZE = 1;
const MAX_SCRYPT_BLOCK_SIZE = 16; // lowered from 32
const MIN_SCRYPT_PARALLELIZATION = 1;
const MAX_SCRYPT_PARALLELIZATION = 4;
const MIN_SCRYPT_MAX_MEMORY_BYTES = 32 * 1024 * 1024;
const MAX_SCRYPT_MAX_MEMORY_BYTES = 128 * 1024 * 1024;
/**
 * Upper bound on the combined scrypt work factor (cost * blockSize * parallelization).
 * Prevents an attacker from choosing individually-valid parameters that combine
 * to produce an excessively expensive derivation (DoS).
 */
const MAX_SCRYPT_WORK_FACTOR = (1 << 17) * 8 * 1; // ~= our own default derivation cost
const SCRYPT_SALT_BYTES = 16;
const GCM_NONCE_BYTES = 12;
const GCM_AUTH_TAG_BYTES = 16;

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

function readSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
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

function assertBase64UrlByteLength(value: string, label: string, expectedBytes: number): void {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch (error) {
    throw new Error(`Invalid snapshot envelope: invalid ${label}.`, { cause: error });
  }
  if (decoded.length !== expectedBytes) {
    throw new Error(`Invalid snapshot envelope: ${label} must decode to ${expectedBytes} bytes.`);
  }
}

function assertValidScryptParams(
  keyDerivation: BackupSnapshotEnvelope["encryption"]["keyDerivation"],
): void {
  const { cost, blockSize, parallelization, maxMemoryBytes } = keyDerivation;
  if (cost < MIN_SCRYPT_COST || cost > MAX_SCRYPT_COST || (cost & (cost - 1)) !== 0) {
    throw new Error(`Invalid snapshot envelope: unsupported encryption.keyDerivation.cost.`);
  }
  if (blockSize < MIN_SCRYPT_BLOCK_SIZE || blockSize > MAX_SCRYPT_BLOCK_SIZE) {
    throw new Error(`Invalid snapshot envelope: unsupported encryption.keyDerivation.blockSize.`);
  }
  if (
    parallelization < MIN_SCRYPT_PARALLELIZATION ||
    parallelization > MAX_SCRYPT_PARALLELIZATION
  ) {
    throw new Error(
      `Invalid snapshot envelope: unsupported encryption.keyDerivation.parallelization.`,
    );
  }
  // Combined work-factor cap to prevent DoS via individually-valid but expensive params.
  if (cost * blockSize * parallelization > MAX_SCRYPT_WORK_FACTOR) {
    throw new Error(
      `Invalid snapshot envelope: combined scrypt work factor (cost*blockSize*parallelization) exceeds allowed limit.`,
    );
  }
  if (
    maxMemoryBytes < MIN_SCRYPT_MAX_MEMORY_BYTES ||
    maxMemoryBytes > MAX_SCRYPT_MAX_MEMORY_BYTES
  ) {
    throw new Error(
      `Invalid snapshot envelope: unsupported encryption.keyDerivation.maxMemoryBytes.`,
    );
  }
}

export function assertValidBackupSnapshotEncryptionMetadata(
  encryption: BackupSnapshotEnvelope["encryption"],
): void {
  assertValidScryptParams(encryption.keyDerivation);
  assertBase64UrlByteLength(
    encryption.keyDerivation.saltBase64Url,
    "encryption.keyDerivation.saltBase64Url",
    SCRYPT_SALT_BYTES,
  );
  assertBase64UrlByteLength(
    encryption.nonceBase64Url,
    "encryption.nonceBase64Url",
    GCM_NONCE_BYTES,
  );
  assertBase64UrlByteLength(
    encryption.authTagBase64Url,
    "encryption.authTagBase64Url",
    GCM_AUTH_TAG_BYTES,
  );
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

  const envelope: BackupSnapshotEnvelope = {
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
      bytes: readSafeInteger(parsed.archive.bytes, "archive.bytes"),
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
        cost: readSafeInteger(
          parsed.encryption.keyDerivation.cost,
          "encryption.keyDerivation.cost",
        ),
        blockSize: readSafeInteger(
          parsed.encryption.keyDerivation.blockSize,
          "encryption.keyDerivation.blockSize",
        ),
        parallelization: readSafeInteger(
          parsed.encryption.keyDerivation.parallelization,
          "encryption.keyDerivation.parallelization",
        ),
        maxMemoryBytes: readSafeInteger(
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
      bytes: readSafeInteger(parsed.ciphertext.bytes, "ciphertext.bytes"),
    },
    ...(typeof parsed.snapshotName === "string" && parsed.snapshotName.trim()
      ? { snapshotName: parsed.snapshotName }
      : {}),
  };
  assertValidBackupSnapshotEncryptionMetadata(envelope.encryption);
  return envelope;
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

/** Read-only store interface for listing snapshots without decryption. */
export type BackupSnapshotListStore = {
  listSnapshots(params: { installationId: string }): Promise<BackupSnapshotEnvelope[]>;
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
