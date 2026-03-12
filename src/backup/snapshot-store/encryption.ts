import crypto from "node:crypto";
import fs from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  assertValidBackupSnapshotEncryptionMetadata,
  type BackupSnapshotEnvelope,
} from "./types.js";

const SCRYPT_COST = 1 << 15;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_MAX_MEMORY_BYTES = 128 * 1024 * 1024;
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
type ScryptOptions = {
  cost: number;
  blockSize: number;
  parallelization: number;
  maxMemoryBytes: number;
};

export type EncryptedArchivePayload = {
  archiveSha256: string;
  archiveBytes: number;
  ciphertext: BackupSnapshotEnvelope["ciphertext"];
  encryption: BackupSnapshotEnvelope["encryption"];
};

class HashPassthrough extends Transform {
  private readonly hash = crypto.createHash("sha256");
  bytes = 0;

  override _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer | string) => void,
  ): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.hash.update(buffer);
    this.bytes += buffer.length;
    callback(null, chunk);
  }

  digestHex(): string {
    return this.hash.digest("hex");
  }
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

async function deriveKey(secret: string, salt: Buffer): Promise<Buffer> {
  return await deriveKeyWithOptions(secret, salt, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
    maxMemoryBytes: SCRYPT_MAX_MEMORY_BYTES,
  });
}

async function deriveKeyWithOptions(
  secret: string,
  salt: Buffer,
  options: ScryptOptions,
): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    crypto.scrypt(
      secret,
      salt,
      KEY_BYTES,
      {
        N: options.cost,
        r: options.blockSize,
        p: options.parallelization,
        maxmem: options.maxMemoryBytes,
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(Buffer.from(derivedKey));
      },
    );
  });
}

export async function encryptArchiveToPayload(params: {
  archivePath: string;
  payloadPath: string;
  secret: string;
}): Promise<EncryptedArchivePayload> {
  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const key = await deriveKey(params.secret, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const archiveDigest = new HashPassthrough();
  const ciphertextDigest = new HashPassthrough();

  await pipeline(
    fs.createReadStream(params.archivePath),
    archiveDigest,
    cipher,
    ciphertextDigest,
    fs.createWriteStream(params.payloadPath, { mode: 0o600 }),
  );

  return {
    archiveSha256: archiveDigest.digestHex(),
    archiveBytes: archiveDigest.bytes,
    ciphertext: {
      sha256: ciphertextDigest.digestHex(),
      bytes: ciphertextDigest.bytes,
    },
    encryption: {
      cipher: "aes-256-gcm",
      keyDerivation: {
        name: "scrypt",
        saltBase64Url: base64UrlEncode(salt),
        cost: SCRYPT_COST,
        blockSize: SCRYPT_BLOCK_SIZE,
        parallelization: SCRYPT_PARALLELIZATION,
        maxMemoryBytes: SCRYPT_MAX_MEMORY_BYTES,
      },
      nonceBase64Url: base64UrlEncode(nonce),
      authTagBase64Url: base64UrlEncode(cipher.getAuthTag()),
    },
  };
}

export async function decryptPayloadToArchive(params: {
  payloadPath: string;
  archivePath: string;
  secret: string;
  envelope: Pick<BackupSnapshotEnvelope, "archive" | "ciphertext" | "encryption">;
}): Promise<void> {
  assertValidBackupSnapshotEncryptionMetadata(params.envelope.encryption);
  const salt = base64UrlDecode(params.envelope.encryption.keyDerivation.saltBase64Url);
  const nonce = base64UrlDecode(params.envelope.encryption.nonceBase64Url);
  const authTag = base64UrlDecode(params.envelope.encryption.authTagBase64Url);
  const key = await deriveKeyWithOptions(params.secret, salt, {
    cost: params.envelope.encryption.keyDerivation.cost,
    blockSize: params.envelope.encryption.keyDerivation.blockSize,
    parallelization: params.envelope.encryption.keyDerivation.parallelization,
    maxMemoryBytes: params.envelope.encryption.keyDerivation.maxMemoryBytes,
  });
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(authTag);
  const ciphertextDigest = new HashPassthrough();
  const archiveDigest = new HashPassthrough();
  const tempArchivePath = `${params.archivePath}.${process.pid}.tmp`;

  try {
    await pipeline(
      fs.createReadStream(params.payloadPath),
      ciphertextDigest,
      decipher,
      archiveDigest,
      fs.createWriteStream(tempArchivePath, { flags: "wx", mode: 0o600 }),
    );

    const archiveSha = archiveDigest.digestHex();
    const ciphertextSha = ciphertextDigest.digestHex();
    if (ciphertextSha !== params.envelope.ciphertext.sha256) {
      throw new Error("Downloaded payload checksum mismatch.");
    }
    if (archiveSha !== params.envelope.archive.sha256) {
      throw new Error("Decrypted archive checksum mismatch.");
    }
    await fs.promises.rename(tempArchivePath, params.archivePath);
  } catch (error) {
    await fs.promises.rm(tempArchivePath, { force: true }).catch(() => undefined);
    throw error;
  }
}
