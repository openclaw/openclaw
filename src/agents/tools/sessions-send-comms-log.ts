/**
 * Agent-to-agent communication logger.
 *
 * Appends a structured JSONL entry to `~/.openclaw/shared/signals/bus.jsonl`
 * every time sessions_send completes. This provides automatic observability
 * for all inter-agent communication without requiring agent cooperation.
 *
 * The log file can be consumed by external dashboards or skills.
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

function resolveLogPath(): string {
  const envDir = process.env.SIGNAL_DIR;
  const dir = envDir || path.join(os.homedir(), ".openclaw", "shared", "signals");
  return path.join(dir, "bus.jsonl");
}

/**
 * Append a communication log entry. Fire-and-forget — errors are silently
 * swallowed so logging never disrupts the sessions_send flow.
 */
export function appendCommsLog(entry: CommsLogEntry): void {
  try {
    const logPath = resolveLogPath();
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(logPath, line, "utf-8");
  } catch {
    // Silently ignore — logging must never break sessions_send
  }
}
