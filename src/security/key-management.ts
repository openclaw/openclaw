import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface KeyProvider {
  getKey(): Promise<Buffer>;
  isAvailable(): Promise<boolean>;
}

export class EnvKeyProvider implements KeyProvider {
  constructor(private envVar = "OPENCLAW_ENCRYPTION_KEY") {}

  async getKey(): Promise<Buffer> {
    const key = process.env[this.envVar];
    if (!key) {
      throw new Error(`Environment variable ${this.envVar} not set`);
    }

    // Require 64 hex chars = 32 bytes (256 bits) for AES-256
    if (!/^[0-9a-f]{64}$/i.test(key)) {
      throw new Error(
        `${this.envVar} must be a 64-character hex string (32 bytes). ` +
          `Generate one with: openssl rand -hex 32`,
      );
    }

    return Buffer.from(key, "hex");
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(process.env[this.envVar]);
  }
}

export class FileKeyProvider implements KeyProvider {
  constructor(private keyPath: string) {}

  async getKey(): Promise<Buffer> {
    // Try to read existing key first
    try {
      const keyHex = fs.readFileSync(this.keyPath, "utf8").trim();
      return Buffer.from(keyHex, "hex");
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }

    // Key doesn't exist - generate and save atomically
    const key = crypto.randomBytes(32);
    const dir = path.dirname(this.keyPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    // Use O_CREAT | O_EXCL for atomic creation (fails if file exists)
    const tempPath = `${this.keyPath}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    try {
      const fd = fs.openSync(
        tempPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      );
      fs.writeSync(fd, key.toString("hex"));
      fs.closeSync(fd);
      fs.renameSync(tempPath, this.keyPath);
    } catch (err: any) {
      // Clean up temp file on error
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      // If another process created the key, read it
      if (err.code === "EEXIST" || fs.existsSync(this.keyPath)) {
        const keyHex = fs.readFileSync(this.keyPath, "utf8").trim();
        return Buffer.from(keyHex, "hex");
      }
      throw err;
    }

    return key;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const dir = path.dirname(this.keyPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Create a key provider with simplified logic:
 * 1. Try environment variable first
 * 2. Fall back to file-based storage
 */
export async function createKeyProvider(
  options: {
    envVar?: string;
    keyPath?: string;
  } = {},
): Promise<KeyProvider> {
  const defaultKeyPath =
    options.keyPath || path.join(process.env.HOME || ".", ".openclaw", "encryption.key");

  // Try environment variable first
  const env = new EnvKeyProvider(options.envVar);
  if (await env.isAvailable()) {
    return env;
  }

  // Fall back to file storage
  return new FileKeyProvider(defaultKeyPath);
}
