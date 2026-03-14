/**
 * Authentication audit logger for the gateway.
 *
 * Writes JSONL entries to `~/.openclaw/logs/gateway-auth.jsonl`.
 * Supports basic file rotation: when the log exceeds a size threshold,
 * it is renamed and a new file is started. Up to N history files are retained.
 */

import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type AuthAuditEventType = "auth_failure" | "auth_success" | "rate_limited" | "ip_blocked";

export type AuthAuditEntry = {
  ts: string;
  event: AuthAuditEventType;
  clientIp?: string;
  method?: string;
  reason?: string;
  user?: string;
};

export interface AuthAuditLogger {
  /** Write an audit entry. Fire-and-forget (errors are swallowed). */
  log(entry: Omit<AuthAuditEntry, "ts">): void;
  /** Flush pending writes (best-effort). */
  flush(): Promise<void>;
}

export type AuthAuditLogConfig = {
  /** Maximum log file size in bytes before rotation. @default 10_485_760 (10 MB) */
  maxBytes?: number;
  /** Number of rotated history files to keep. @default 3 */
  maxFiles?: number;
  /** Override log directory (for testing). */
  logDir?: string;
};

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_FILES = 3;
const LOG_FILE_NAME = "gateway-auth.jsonl";

function resolveLogDir(override?: string): string {
  return override ?? path.join(resolveStateDir(), "logs");
}

export function createAuthAuditLogger(config?: AuthAuditLogConfig): AuthAuditLogger {
  const maxBytes = config?.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = config?.maxFiles ?? DEFAULT_MAX_FILES;
  const logDir = resolveLogDir(config?.logDir);
  const logPath = path.join(logDir, LOG_FILE_NAME);

  let pendingWrite: Promise<void> = Promise.resolve();
  let dirEnsured = false;

  async function ensureDir(): Promise<void> {
    if (dirEnsured) {
      return;
    }
    await mkdir(logDir, { recursive: true });
    dirEnsured = true;
  }

  async function rotateIfNeeded(): Promise<void> {
    try {
      const stats = await stat(logPath);
      if (stats.size < maxBytes) {
        return;
      }
    } catch {
      // File doesn't exist yet — no rotation needed.
      return;
    }

    // Remove oldest history file if at capacity.
    for (let i = maxFiles; i >= 1; i--) {
      const older = path.join(logDir, `gateway-auth.${i}.jsonl`);
      if (i === maxFiles) {
        try {
          await unlink(older);
        } catch {
          // Ignore missing.
        }
      } else {
        const newer = path.join(logDir, `gateway-auth.${i + 1}.jsonl`);
        try {
          await rename(older, newer);
        } catch {
          // Ignore missing.
        }
      }
    }

    try {
      await rename(logPath, path.join(logDir, "gateway-auth.1.jsonl"));
    } catch {
      // Ignore — file may have been removed concurrently.
    }
  }

  async function writeEntry(entry: AuthAuditEntry): Promise<void> {
    try {
      await ensureDir();
      await rotateIfNeeded();
      const line = JSON.stringify(entry) + "\n";
      await appendFile(logPath, line, "utf-8");
    } catch {
      // Swallow errors — audit logging must never crash the gateway.
    }
  }

  function log(entry: Omit<AuthAuditEntry, "ts">): void {
    const full: AuthAuditEntry = {
      ts: new Date().toISOString(),
      ...entry,
    };
    pendingWrite = pendingWrite.then(() => writeEntry(full));
  }

  async function flush(): Promise<void> {
    await pendingWrite;
  }

  return { log, flush };
}
