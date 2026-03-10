import fs from "node:fs/promises";
import path from "node:path";
import { withFileLock, type FileLockOptions } from "./file-lock.js";
import { readJsonFile, writeJsonAtomic } from "./json-files.js";

const STORE_FILENAME = "pending-inbound.json";

/**
 * Lock options for pending-inbound-store read-modify-write operations.
 * Mirrors AUTH_STORE_LOCK_OPTIONS from auth-profiles.
 */
const PENDING_INBOUND_LOCK_OPTIONS: FileLockOptions = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 30_000,
};

/**
 * An inbound message captured during gateway drain.
 * Stored to disk so it survives restart and can be replayed.
 */
export type PendingInboundEntry = {
  channel: string;
  id: string;
  payload: unknown;
  capturedAt: number;
  /** Resolved session key at capture time (used for accurate replay routing). */
  sessionKey?: string;
};

/**
 * An active agent turn tracked so we can detect stale runs after restart.
 * Written at run start, cleared at run end. Any entry surviving a restart
 * is stale by definition — the process died mid-turn.
 */
export type ActiveTurnEntry = {
  sessionId: string;
  sessionKey: string;
  channel: string;
  startedAt: number;
};

type PendingInboundFile = {
  version: 1;
  entries: Record<string, PendingInboundEntry>;
  activeTurns?: Record<string, ActiveTurnEntry>;
};

function storeKey(entry: Pick<PendingInboundEntry, "channel" | "id">): string {
  return `${entry.channel}:${entry.id}`;
}

function resolveStorePath(stateDir: string): string {
  return path.join(stateDir, STORE_FILENAME);
}

/**
 * Append (or overwrite by dedup key) a pending inbound entry.
 * Uses atomic write (tmp + rename) following the update-offset-store pattern.
 * Wrapped in a file lock to prevent concurrent read-modify-write races.
 */
export async function writePendingInbound(
  stateDir: string,
  entry: PendingInboundEntry,
): Promise<void> {
  const filePath = resolveStorePath(stateDir);
  await withFileLock(filePath, PENDING_INBOUND_LOCK_OPTIONS, async () => {
    const existing = await readPendingInboundFile(filePath);
    const key = storeKey(entry);
    existing.entries[key] = entry;
    await writeJsonAtomic(filePath, existing, {
      mode: 0o600,
      trailingNewline: true,
      ensureDirMode: 0o700,
    });
  });
}

/**
 * Read all pending inbound entries. Returns [] if the file doesn't exist.
 */
export async function readPendingInbound(stateDir: string): Promise<PendingInboundEntry[]> {
  const filePath = resolveStorePath(stateDir);
  const data = await readPendingInboundFile(filePath);
  return Object.values(data.entries);
}

/**
 * Remove the pending inbound file entirely.
 * @deprecated Use `clearPendingInboundEntries` or `clearActiveTurns` to avoid
 * nuking data belonging to the other key.
 */
export async function clearPendingInbound(stateDir: string): Promise<void> {
  const filePath = resolveStorePath(stateDir);
  try {
    await fs.unlink(filePath);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return;
    }
    throw err;
  }
}

/**
 * Clear only the `entries` (pending inbound messages), leaving `activeTurns` intact.
 */
export async function clearPendingInboundEntries(stateDir: string): Promise<void> {
  const filePath = resolveStorePath(stateDir);
  await withFileLock(filePath, PENDING_INBOUND_LOCK_OPTIONS, async () => {
    const existing = await readPendingInboundFile(filePath);
    if (Object.keys(existing.entries).length === 0) {
      return; // nothing to clear
    }
    existing.entries = {};
    await writeJsonAtomic(filePath, existing, {
      mode: 0o600,
      trailingNewline: true,
      ensureDirMode: 0o700,
    });
  });
}

/**
 * Clear only the `activeTurns` key, leaving pending inbound `entries` intact.
 */
export async function clearAllActiveTurns(stateDir: string): Promise<void> {
  const filePath = resolveStorePath(stateDir);
  await withFileLock(filePath, PENDING_INBOUND_LOCK_OPTIONS, async () => {
    const existing = await readPendingInboundFile(filePath);
    if (!existing.activeTurns || Object.keys(existing.activeTurns).length === 0) {
      return; // nothing to clear
    }
    existing.activeTurns = {};
    await writeJsonAtomic(filePath, existing, {
      mode: 0o600,
      trailingNewline: true,
      ensureDirMode: 0o700,
    });
  });
}

/**
 * Upsert an active-turn entry keyed by sessionId.
 * Wrapped in a file lock to prevent concurrent read-modify-write races.
 */
export async function writeActiveTurn(stateDir: string, entry: ActiveTurnEntry): Promise<void> {
  const filePath = resolveStorePath(stateDir);
  await withFileLock(filePath, PENDING_INBOUND_LOCK_OPTIONS, async () => {
    const existing = await readPendingInboundFile(filePath);
    if (!existing.activeTurns) {
      existing.activeTurns = {};
    }
    existing.activeTurns[entry.sessionId] = entry;
    await writeJsonAtomic(filePath, existing, {
      mode: 0o600,
      trailingNewline: true,
      ensureDirMode: 0o700,
    });
  });
}

/**
 * Remove an active-turn entry by sessionId.
 * Wrapped in a file lock to prevent concurrent read-modify-write races.
 */
export async function clearActiveTurn(stateDir: string, sessionId: string): Promise<void> {
  const filePath = resolveStorePath(stateDir);
  await withFileLock(filePath, PENDING_INBOUND_LOCK_OPTIONS, async () => {
    const existing = await readPendingInboundFile(filePath);
    if (!existing.activeTurns) {
      return;
    }
    delete existing.activeTurns[sessionId];
    await writeJsonAtomic(filePath, existing, {
      mode: 0o600,
      trailingNewline: true,
      ensureDirMode: 0o700,
    });
  });
}

/**
 * Read all active-turn entries. At startup every surviving entry is stale
 * (the process died before clearing it). Returns [] if the file or key
 * doesn't exist.
 */
export async function readStaleActiveTurns(stateDir: string): Promise<ActiveTurnEntry[]> {
  const filePath = resolveStorePath(stateDir);
  const data = await readPendingInboundFile(filePath);
  if (!data.activeTurns) {
    return [];
  }
  return Object.values(data.activeTurns);
}

async function readPendingInboundFile(filePath: string): Promise<PendingInboundFile> {
  const data = await readJsonFile<PendingInboundFile>(filePath);
  if (data && data.version === 1 && typeof data.entries === "object" && data.entries !== null) {
    return data;
  }
  return { version: 1, entries: {} };
}
