/**
 * Agent-to-agent communication logger.
 *
 * Appends a structured JSONL entry to `~/.openclaw/shared/signals/bus.jsonl`
 * every time sessions_send completes. This provides automatic observability
 * for all inter-agent communication without requiring agent cooperation.
 *
 * The log file can be consumed by external dashboards or skills.
 *
 * Privacy note: message/reply previews are truncated to 200 chars. Operators
 * who handle sensitive user data can disable logging entirely by setting
 * the environment variable OPENCLAW_COMMS_LOG=off, or override the log
 * directory with SIGNAL_DIR.
 *
 * Size management: the log file is capped at MAX_LOG_SIZE_BYTES (50 MB).
 * When the limit is reached, logging silently stops until the file is
 * rotated or truncated externally (e.g. by a cron job or dashboard tool).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CommsLogEntry {
  /** Signal type — always "MESSAGE" for sessions_send */
  type: "MESSAGE";
  /** Source agent session key */
  from: string;
  /** Target agent session key */
  to: string;
  /** ISO 8601 timestamp */
  ts: string;
  /** Outcome: ok, accepted, timeout, error, forbidden */
  status: string;
  /** Truncated message (first 200 chars) */
  messagePreview?: string;
  /** Truncated reply (first 200 chars) */
  replyPreview?: string;
}

const MAX_PREVIEW = 200;
/** Stop logging when bus.jsonl exceeds 50 MB */
const MAX_LOG_SIZE_BYTES = 50 * 1024 * 1024;

function truncate(text: string | undefined): string | undefined {
  if (text === undefined || text === null) {
    return undefined;
  }
  return text.length > MAX_PREVIEW ? text.slice(0, MAX_PREVIEW) + "…" : text;
}

function resolveLogPath(): string {
  const envDir = process.env.SIGNAL_DIR;
  const dir = envDir || path.join(os.homedir(), ".openclaw", "shared", "signals");
  return path.join(dir, "bus.jsonl");
}

function isLoggingEnabled(): boolean {
  const flag = process.env.OPENCLAW_COMMS_LOG;
  return flag !== "off" && flag !== "false" && flag !== "0";
}

/** Cached directory path to avoid repeated mkdir calls. Reset if path changes. */
let ensuredDir = "";

/**
 * Append a communication log entry. Fire-and-forget — errors are silently
 * swallowed so logging never disrupts the sessions_send flow.
 * Uses fully async I/O to avoid blocking the event loop.
 */
export function appendCommsLog(entry: CommsLogEntry): void {
  if (!isLoggingEnabled()) {
    return;
  }

  const truncated: CommsLogEntry = {
    ...entry,
    messagePreview: truncate(entry.messagePreview),
    replyPreview: truncate(entry.replyPreview),
  };

  const logPath = resolveLogPath();
  const line = JSON.stringify(truncated) + "\n";

  const doAppend = async () => {
    try {
      // Ensure directory exists (once per process)
      const dir = path.dirname(logPath);
      if (ensuredDir !== dir) {
        ensuredDir = dir; // Optimistically mark before await
        await fs.promises.mkdir(dir, { recursive: true });
      }

      // Size guard: skip if file exceeds limit.
      // Note: concurrent writers may each pass this check before any append
      // completes, so the actual cap is approximately MAX_LOG_SIZE_BYTES.
      try {
        const stat = await fs.promises.stat(logPath);
        if (stat.size > MAX_LOG_SIZE_BYTES) {
          return;
        }
      } catch {
        // File doesn't exist yet — that's fine, append will create it
      }

      await fs.promises.appendFile(logPath, line, "utf-8");
    } catch {
      // Silently ignore — logging must never break sessions_send
    }
  };

  void doAppend();
}
