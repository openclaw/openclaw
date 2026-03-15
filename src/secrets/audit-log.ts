/**
 * Audit logging for credential access and grants.
 *
 * Writes JSONL (JSON Lines) to {dataDir}/audit/credentials.jsonl.
 * Each line is a JSON object with event details.
 */

import { mkdir, appendFile, stat, rename, readFile } from "node:fs/promises";
import os from "node:os";
import { join, dirname } from "node:path";
import { resolveStateDir, resolveConfigPath } from "../config/paths.js";

/** Max audit log size before rotation (5MB). */
const MAX_LOG_SIZE = 5 * 1024 * 1024;

/**
 * Audit log entry.
 */
export interface AuditEntry {
  /** Event type */
  event:
    | "credential_accessed"
    | "metadata_accessed"
    | "grant_created"
    | "grant_revoked"
    | "credential_resolved"
    | "credential_denied";
  /** Secret name */
  name: string;
  /** Tool name (for credential_resolved) */
  tool?: string;
  /** Timestamp (milliseconds since epoch) */
  timestamp: number;
  /** Additional context */
  details?: Record<string, unknown>;
}

/**
 * Expand leading ~ or ~/ in a path to the OS home directory.
 */
function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return p.replace(/^~(?=$|[/])/, os.homedir());
  }
  return p;
}

/**
 * Get audit log file path, respecting config override with tilde expansion.
 */
async function getAuditLogPath(): Promise<string> {
  try {
    const raw = await readFile(resolveConfigPath(process.env), "utf-8");
    const cfg = JSON.parse(raw) as { auditLog?: string };
    if (cfg.auditLog) {
      return expandTilde(cfg.auditLog);
    }
  } catch {
    // Config unreadable — fall back to default
  }
  return join(resolveStateDir(process.env), "audit", "credentials.jsonl");
}

/**
 * Log an audit entry.
 * @param entry Audit entry to log
 */
export async function auditLog(entry: AuditEntry): Promise<void> {
  const logPath = await getAuditLogPath();
  const logDir = dirname(logPath);

  // Ensure audit directory exists with restricted permissions
  await mkdir(logDir, { recursive: true, mode: 0o700 });

  // Rotate if log exceeds max size
  try {
    const stats = await stat(logPath);
    if (stats.size > MAX_LOG_SIZE) {
      const rotatedPath = logPath.replace(".jsonl", `.${Date.now()}.jsonl`);
      await rename(logPath, rotatedPath);
    }
  } catch {
    // File doesn't exist yet, no rotation needed
  }

  // Append JSON line
  const line = JSON.stringify(entry) + "\n";
  await appendFile(logPath, line, { encoding: "utf-8", mode: 0o600 });
}
