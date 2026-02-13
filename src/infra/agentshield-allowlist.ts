import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

/**
 * Fingerprint-based allowlist for AgentShield allow-always decisions.
 *
 * When an operator approves with "allow-always", the argsFingerprint is added
 * to this allowlist. Future tool calls with the same fingerprint are auto-allowed.
 *
 * File: <stateDir>/agentshield/allowlist.json
 */

export type AllowlistEntry = {
  fingerprint: string;
  toolName: string;
  createdAt: string;
  notes?: string;
  approvalId?: string;
};

export type AllowlistData = {
  version: 1;
  entries: AllowlistEntry[];
};

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function writeJsonSecure(filepath: string, data: unknown): void {
  const dir = path.dirname(filepath);
  ensureDir(dir);
  const content = JSON.stringify(data, null, 2) + "\n";
  fs.writeFileSync(filepath, content, { mode: 0o600 });
}

function readJson<T>(filepath: string): T | null {
  if (!fs.existsSync(filepath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filepath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export class AgentShieldAllowlist {
  private filepath: string;

  constructor(stateDir?: string) {
    const resolvedStateDir = stateDir ?? resolveStateDir();
    this.filepath = path.join(resolvedStateDir, "agentshield", "allowlist.json");
  }

  /**
   * Load the allowlist from disk.
   */
  private load(): AllowlistData {
    const data = readJson<AllowlistData>(this.filepath);
    if (data && data.version === 1 && Array.isArray(data.entries)) {
      return data;
    }
    return { version: 1, entries: [] };
  }

  /**
   * Save the allowlist to disk.
   */
  private save(data: AllowlistData): void {
    writeJsonSecure(this.filepath, data);
  }

  /**
   * Check if a fingerprint is in the allowlist.
   */
  isAllowed(fingerprint: string): boolean {
    const data = this.load();
    return data.entries.some((e) => e.fingerprint === fingerprint);
  }

  /**
   * Check if a fingerprint+tool combination is in the allowlist.
   */
  isAllowedForTool(fingerprint: string, toolName: string): boolean {
    const data = this.load();
    return data.entries.some((e) => e.fingerprint === fingerprint && e.toolName === toolName);
  }

  /**
   * Get an allowlist entry by fingerprint.
   */
  get(fingerprint: string): AllowlistEntry | null {
    const data = this.load();
    return data.entries.find((e) => e.fingerprint === fingerprint) ?? null;
  }

  /**
   * Add a fingerprint to the allowlist.
   */
  add(entry: AllowlistEntry): void {
    const data = this.load();
    // Remove existing entry with same fingerprint (update)
    data.entries = data.entries.filter((e) => e.fingerprint !== entry.fingerprint);
    data.entries.push(entry);
    // Sort by createdAt descending
    data.entries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    this.save(data);
  }

  /**
   * Remove a fingerprint from the allowlist.
   */
  remove(fingerprint: string): boolean {
    const data = this.load();
    const originalLength = data.entries.length;
    data.entries = data.entries.filter((e) => e.fingerprint !== fingerprint);
    if (data.entries.length !== originalLength) {
      this.save(data);
      return true;
    }
    return false;
  }

  /**
   * List all allowlist entries.
   */
  list(): AllowlistEntry[] {
    return this.load().entries;
  }

  /**
   * Clear all allowlist entries.
   */
  clear(): void {
    this.save({ version: 1, entries: [] });
  }
}
