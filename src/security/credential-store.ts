/**
 * Unified credential store adapter with transparent plaintext-to-encrypted migration.
 *
 * - readCredentialJson: Reads a JSON file, auto-detecting encrypted vs plaintext format.
 *   If encrypted, decrypts transparently. If plaintext, returns parsed data as-is.
 * - writeCredentialJson: Writes a JSON file. Encrypts unless mode is "plaintext".
 *
 * Transparent migration: plaintext files are readable; they get encrypted on next write.
 */

import fs from "node:fs";
import path from "node:path";
import { writeFileSecure } from "../infra/json-file.js";
import {
  decryptCredential,
  encryptCredential,
  isEncryptedEnvelope,
} from "./credential-encryption.js";

export type CredentialEncryptionMode = "encrypted" | "plaintext";

export type CredentialStoreOptions = {
  /** Device private key PEM for encryption/decryption. */
  privateKeyPem: string;
  /** Whether to write encrypted or plaintext. Defaults to "encrypted". */
  mode?: CredentialEncryptionMode;
};

/**
 * Read a credential JSON file with transparent decryption.
 *
 * Detection logic:
 * - If the parsed JSON has the encrypted envelope structure → decrypt and return parsed content.
 * - Otherwise → return parsed plaintext JSON as-is.
 * - If the file doesn't exist or can't be parsed → return undefined.
 */
export function readCredentialJson(filePath: string, options: CredentialStoreOptions): unknown {
  try {
    if (!fs.existsSync(filePath)) {
      return undefined;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    if (isEncryptedEnvelope(parsed)) {
      const decrypted = decryptCredential(parsed, options.privateKeyPem);
      return JSON.parse(decrypted) as unknown;
    }

    // Plaintext JSON — return as-is (will be encrypted on next write).
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Write a credential JSON file, encrypting by default.
 *
 * When mode is "encrypted" (default), the data is serialized to JSON,
 * encrypted with AES-256-GCM, and written as an encrypted envelope.
 *
 * When mode is "plaintext", the data is written as standard JSON (for CI/headless).
 *
 * File permissions are set to 0o600 regardless of encryption mode.
 */
export function writeCredentialJson(
  filePath: string,
  data: unknown,
  options: CredentialStoreOptions,
): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const mode = options.mode ?? "encrypted";
  let content: string;

  if (mode === "encrypted") {
    const plaintext = JSON.stringify(data, null, 2);
    const envelope = encryptCredential(plaintext, options.privateKeyPem);
    content = `${JSON.stringify(envelope, null, 2)}\n`;
  } else {
    content = `${JSON.stringify(data, null, 2)}\n`;
  }

  writeFileSecure(filePath, content);
}

/**
 * Check if a file on disk contains an encrypted credential envelope.
 */
export function isFileEncrypted(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) {
      return false;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isEncryptedEnvelope(parsed);
  } catch {
    return false;
  }
}
