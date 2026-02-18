import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Encrypted at-rest storage for tool call args pending retry.
 *
 * Uses AES-256-GCM with a machine-local key file.
 * All files written with 0o600 permissions.
 * Raw args are never exposed — only SHA-256 fingerprints of canonical params JSON.
 */

export type RetryEntry = {
  toolName: string;
  /** Canonical JSON string of tool params (never logged, only hashed). */
  paramsJSON: string;
  ctx: Record<string, unknown>;
};

export function argsFingerprint(paramsJSON: string): string {
  return createHash("sha256").update(paramsJSON).digest("hex");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function encrypt(key: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // iv (12) + tag (16) + ciphertext
  return Buffer.concat([iv, tag, encrypted]);
}

function decrypt(key: Buffer, blob: Buffer): Buffer {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ciphertext = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export class AgentShieldRetryStore {
  private dir: string;
  private keyPath: string;
  private key: Buffer;

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, "agentshield-retries");
    ensureDir(this.dir);
    this.keyPath = path.join(this.dir, ".key");
    this.key = this.loadOrCreateKey();
  }

  private loadOrCreateKey(): Buffer {
    if (fs.existsSync(this.keyPath)) {
      return fs.readFileSync(this.keyPath);
    }
    const key = randomBytes(32);
    fs.writeFileSync(this.keyPath, key, { mode: 0o600 });
    return key;
  }

  store(id: string, toolName: string, paramsJSON: string, ctx?: Record<string, unknown>): string {
    const entry: RetryEntry = { toolName, paramsJSON, ctx: ctx ?? {} };
    const plaintext = Buffer.from(JSON.stringify(entry), "utf8");
    const encrypted = encrypt(this.key, plaintext);
    const filePath = path.join(this.dir, `${id}.enc`);
    fs.writeFileSync(filePath, encrypted, { mode: 0o600 });
    return argsFingerprint(paramsJSON);
  }

  load(id: string): RetryEntry {
    const filePath = path.join(this.dir, `${id}.enc`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`retry entry not found: ${id}`);
    }
    const blob = fs.readFileSync(filePath);
    const plaintext = decrypt(this.key, blob);
    return JSON.parse(plaintext.toString("utf8")) as RetryEntry;
  }

  remove(id: string): boolean {
    const filePath = path.join(this.dir, `${id}.enc`);
    if (!fs.existsSync(filePath)) {
      return false;
    }
    fs.unlinkSync(filePath);
    return true;
  }

  listIds(): string[] {
    if (!fs.existsSync(this.dir)) {
      return [];
    }
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".enc"))
      .map((f) => f.replace(/\.enc$/, ""))
      .toSorted();
  }
}
