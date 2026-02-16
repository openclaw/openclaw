import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { SecurityEvent } from "./events.js";

export type AuditLogEntry = {
  seq: number;
  timestamp: string;
  prevHash: string;
  event: SecurityEvent;
  hash: string;
};

/**
 * Deterministic JSON serialization with explicit key ordering.
 * Prevents hash mismatches from different object construction orders.
 */
export function canonicalize(entry: Omit<AuditLogEntry, "hash">): string {
  const event = entry.event;
  const orderedEvent: Record<string, unknown> = {
    eventType: event.eventType,
    timestamp: event.timestamp,
    severity: event.severity,
    action: event.action,
  };
  if (event.sessionKey !== undefined) orderedEvent.sessionKey = event.sessionKey;
  if (event.channel !== undefined) orderedEvent.channel = event.channel;
  if (event.detail !== undefined) orderedEvent.detail = event.detail;
  if (event.meta !== undefined) {
    // Sort meta keys for determinism
    const sortedMeta: Record<string, unknown> = {};
    for (const key of Object.keys(event.meta).sort()) {
      sortedMeta[key] = event.meta[key];
    }
    orderedEvent.meta = sortedMeta;
  }

  const ordered = {
    seq: entry.seq,
    timestamp: entry.timestamp,
    prevHash: entry.prevHash,
    event: orderedEvent,
  };

  return JSON.stringify(ordered);
}

export function computeHash(canonicalized: string): string {
  return crypto.createHash("sha256").update(canonicalized, "utf-8").digest("hex");
}

export function resolveAuditLogPath(stateDir?: string): string {
  const dir = stateDir ?? resolveStateDir();
  return path.join(dir, "security", "audit.jsonl");
}

// Singleton writer state
let writeChain = Promise.resolve();
let lastHash = "GENESIS";
let lastSeq = 0;
let initialized = false;
let auditLogPathOverride: string | undefined;

/**
 * Override the audit log path (for testing).
 */
export function setAuditLogPath(logPath: string | undefined): void {
  auditLogPathOverride = logPath;
}

/**
 * Reset module state to defaults (for testing).
 */
export function resetAuditWriter(): void {
  writeChain = Promise.resolve();
  lastHash = "GENESIS";
  lastSeq = 0;
  initialized = false;
  auditLogPathOverride = undefined;
}

/**
 * Recover state from existing audit log by reading the last valid line.
 */
async function recoverState(): Promise<void> {
  const logPath = auditLogPathOverride ?? resolveAuditLogPath();
  let raw: string;
  try {
    raw = await fs.readFile(logPath, "utf-8");
  } catch {
    // File doesn't exist — keep GENESIS defaults
    return;
  }

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return;

  // Try last line, then second-to-last if last is truncated
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 2); i--) {
    try {
      const entry = JSON.parse(lines[i]!) as AuditLogEntry;
      if (typeof entry.seq === "number" && typeof entry.hash === "string") {
        lastHash = entry.hash;
        lastSeq = entry.seq;
        return;
      }
    } catch {
      // Truncated or invalid JSON — try previous line
    }
  }
}

/**
 * Append a security event to the hash-chained audit log.
 * Fire-and-forget: returns void synchronously, writes are serialized internally.
 */
export function appendAuditEntry(event: SecurityEvent): void {
  writeChain = writeChain.catch(() => undefined).then(async () => {
    if (!initialized) {
      await recoverState();
      initialized = true;
    }

    const logPath = auditLogPathOverride ?? resolveAuditLogPath();
    const dir = path.dirname(logPath);

    const entryWithoutHash: Omit<AuditLogEntry, "hash"> = {
      seq: lastSeq + 1,
      timestamp: event.timestamp,
      prevHash: lastHash,
      event,
    };

    const canonicalized = canonicalize(entryWithoutHash);
    const hash = computeHash(canonicalized);

    const fullEntry: AuditLogEntry = {
      ...entryWithoutHash,
      hash,
    };

    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.appendFile(logPath, `${JSON.stringify(fullEntry)}\n`, "utf-8");

    // Best-effort file permissions
    try {
      await fs.chmod(logPath, 0o600);
    } catch {
      // May fail on some platforms
    }

    lastHash = hash;
    lastSeq = fullEntry.seq;
  });
}

/**
 * Wait for all pending writes to complete (for testing).
 */
export async function flushAuditWriter(): Promise<void> {
  await writeChain;
}
