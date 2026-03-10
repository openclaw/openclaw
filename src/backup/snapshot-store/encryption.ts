import crypto from "node:crypto";
import fs from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { BackupSnapshotEnvelope } from "./types.js";

const SCRYPT_COST = 1 << 15;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_MAX_MEMORY_BYTES = 128 * 1024 * 1024;
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

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
  return await new Promise((resolve, reject) => {
    crypto.scrypt(
      secret,
      salt,
      KEY_BYTES,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION,
        maxmem: SCRYPT_MAX_MEMORY_BYTES,
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
}): Promise<Pick<BackupSnapshotEnvelope, "archive" | "ciphertext" | "encryption">> {
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
    archive: {
      format: "openclaw-backup-tar-gz",
      archiveRoot: "",
      createdAt: "",
      mode: "full-host",
      includeWorkspace: true,
      verified: false,
      sha256: archiveDigest.digestHex(),
      bytes: archiveDigest.bytes,
    },
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
  const salt = base64UrlDecode(params.envelope.encryption.keyDerivation.saltBase64Url);
  const nonce = base64UrlDecode(params.envelope.encryption.nonceBase64Url);
  const authTag = base64UrlDecode(params.envelope.encryption.authTagBase64Url);
  const key = await deriveKey(params.secret, salt);
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
