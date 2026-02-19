/**
 * File-backed WAL for ConsentGate with rotation and retention.
 * Append-only; rotates by size and keeps a bounded number of files.
 */

import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import type { WalEvent } from "./types.js";
import type { WalWriter } from "./wal.js";

const DEFAULT_MAX_FILES_EXPORT = 5;

const WAL_DIR = "wal";
const WAL_PREFIX = "wal";
const WAL_EXT = ".jsonl";
const DEFAULT_MAX_SIZE_BYTES = 2 * 1024 * 1024; // 2MB
const DEFAULT_MAX_FILES = 5;

export type FileBackedWalOptions = {
  /** Rotate when current file reaches this size (default 2MB). */
  maxSizeBytes?: number;
  /** Keep at most this many rotated files (default 5). */
  maxFiles?: number;
};

/**
 * Create a WAL writer that appends to files under storagePath/wal/.
 * Files are wal.0.jsonl (current), wal.1.jsonl, ...; rotation when size exceeds maxSizeBytes.
 */
export function createFileBackedWal(
  storagePath: string,
  options: FileBackedWalOptions = {},
): WalWriter {
  const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const walDir = path.join(storagePath, WAL_DIR);

  function ensureDir(): void {
    mkdirSync(walDir, { recursive: true });
  }

  function currentPath(): string {
    return path.join(walDir, `${WAL_PREFIX}.0${WAL_EXT}`);
  }

  function rotatedPath(index: number): string {
    return path.join(walDir, `${WAL_PREFIX}.${index}${WAL_EXT}`);
  }

  function rotate(): void {
    ensureDir();
    // Remove oldest if present.
    const oldestPath = rotatedPath(maxFiles);
    if (existsSync(oldestPath)) {
      unlinkSync(oldestPath);
    }
    // Shift: wal.(n-1) -> wal.n for n from maxFiles-1 down to 1.
    for (let n = maxFiles - 1; n >= 1; n--) {
      const from = rotatedPath(n - 1);
      const to = rotatedPath(n);
      if (existsSync(from)) {
        renameSync(from, to);
      }
    }
  }

  return {
    append(partial: Omit<WalEvent, "eventId" | "ts">) {
      ensureDir();
      const event: WalEvent = {
        eventId: randomUUID(),
        ts: Date.now(),
        ...partial,
      };
      const line = JSON.stringify(event) + "\n";
      const filePath = currentPath();
      appendFileSync(filePath, line, "utf-8");
      try {
        const st = statSync(filePath);
        if (st.size >= maxSizeBytes) {
          rotate();
        }
      } catch {
        // Ignore stat errors (e.g. just rotated).
      }
    },
  };
}

export type ReadWalEventsOptions = {
  sinceMs?: number;
  untilMs?: number;
  limit?: number;
  correlationId?: string;
};

/**
 * Read WAL events from file-backed storage (for audit export).
 * Events are returned in chronological order (oldest first). Requires storagePath to be set.
 */
export function readWalEventsFromStorage(
  storagePath: string,
  options: ReadWalEventsOptions = {},
): WalEvent[] {
  const walDir = path.join(storagePath, WAL_DIR);
  if (!existsSync(walDir)) {
    return [];
  }
  const sinceMs = options.sinceMs ?? 0;
  const untilMs = options.untilMs ?? Number.MAX_SAFE_INTEGER;
  const limit = options.limit ?? 1000;
  const correlationId = options.correlationId?.trim();

  const out: WalEvent[] = [];
  // Read from highest index (oldest) to 0 (newest) for chronological order.
  for (let n = DEFAULT_MAX_FILES_EXPORT - 1; n >= 0 && out.length < limit; n--) {
    const filePath = path.join(walDir, `${WAL_PREFIX}.${n}${WAL_EXT}`);
    if (!existsSync(filePath)) continue;
    try {
      const raw = readFileSync(filePath, "utf-8");
      const lines = raw.split("\n").filter((line) => line.trim());
      for (const line of lines) {
        if (out.length >= limit) break;
        try {
          const event = JSON.parse(line) as WalEvent;
          if (event.ts < sinceMs || event.ts > untilMs) continue;
          if (correlationId && event.correlationId !== correlationId) continue;
          out.push(event);
        } catch {
          // Skip malformed lines.
        }
      }
    } catch {
      // Skip unreadable files.
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out.slice(0, limit);
}
