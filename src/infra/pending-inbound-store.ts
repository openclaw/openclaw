import fs from "node:fs/promises";
import path from "node:path";
import { withFileLock, type FileLockOptions } from "./file-lock.js";
import { readJsonFile, writeJsonAtomic } from "./json-files.js";

const STORE_FILENAME = "pending-inbound.json";

/** Maximum number of pending inbound entries before oldest are pruned. */
const MAX_PENDING_ENTRIES = 200;

/** Maximum number of active turn entries before oldest are pruned. */
const MAX_ACTIVE_TURNS = 50;

/**
 * In-process operation queue keyed by resolved file path.
 *
 * `withFileLock` is reentrant for the same process (it increments a counter
 * rather than blocking), so concurrent in-process callers can still
 * read-modify-write the same stale snapshot.  This map serializes operations
 * on the same file path within the current process by chaining each new
 * operation onto the previous promise — guaranteeing sequential execution
 * even when the file lock is already held.
 *
 * The cross-process file lock is still acquired inside each operation to
 * protect against concurrent writes from other processes.
 */
const inProcessOpQueue = new Map<string, Promise<void>>();

/**
 * Serialize an async operation on `filePath` within this process.
 * Each call chains onto the previous pending operation for the same path,
 * ensuring sequential read-modify-write even when `withFileLock` is
 * reentrant.
 */
function withInProcessQueue(filePath: string, fn: () => Promise<void>): Promise<void> {
  const prev = inProcessOpQueue.get(filePath) ?? Promise.resolve();
  // Chain the new operation.  Use .then(fn, fn) so a rejected predecessor
  // does not skip this operation (mirrors status-reactions.ts pattern).
  const next = prev.then(fn, fn);
  inProcessOpQueue.set(filePath, next);
  // Clean up the map entry once the chain settles to avoid unbounded growth
  // for paths that are written once and never again.
  // Note: next.finally() returns a new promise that mirrors next's rejection.
  // Without a .catch(), Node 22 would emit an unhandled-rejection event (which
  // can terminate the gateway) if `next` rejects, e.g. due to a lock timeout
  // or an atomic-write error.  The rejection is already surfaced to the caller
  // via the `next` promise that this function returns, so suppressing it on
  // the cleanup wrapper is correct and safe.
  next
    .finally(() => {
      if (inProcessOpQueue.get(filePath) === next) {
        inProcessOpQueue.delete(filePath);
      }
    })
    .catch(() => {});
  return next;
}

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
  /**
   * Account identity for channels that support multiple bot accounts watching
   * the same channel simultaneously (e.g. Discord multi-account setups).
   * When present, included in the dedup key so each account's capture is
   * stored independently: `channel:accountId:id` rather than `channel:id`.
   */
  accountId?: string;
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

function storeKey(entry: Pick<PendingInboundEntry, "channel" | "id" | "accountId">): string {
  return entry.accountId
    ? `${entry.channel}:${entry.accountId}:${entry.id}`
    : `${entry.channel}:${entry.id}`;
}

function resolveStorePath(stateDir: string): string {
  return path.join(stateDir, STORE_FILENAME);
}

/**
 * Append (or overwrite by dedup key) a pending inbound entry.
 * Uses atomic write (tmp + rename) following the update-offset-store pattern.
 * Wrapped in a file lock to prevent concurrent read-modify-write races.
 *
 * Returns false without writing if the store is already at capacity and the
 * entry is not a dedup overwrite.  This prevents silent message loss — the
 * caller can log a warning or take corrective action.
 */
export async function writePendingInbound(
  stateDir: string,
  entry: PendingInboundEntry,
): Promise<boolean> {
  const filePath = resolveStorePath(stateDir);
  let accepted = true;
  await withInProcessQueue(filePath, () =>
    withFileLock(filePath, PENDING_INBOUND_LOCK_OPTIONS, async () => {
      const existing = await readPendingInboundFile(filePath);
      const key = storeKey(entry);
      // Allow dedup overwrites (same key already present) even when at capacity.
      // Reject genuinely new entries when the store is full to avoid silently
      // dropping oldest messages that were captured first.
      if (
        !(key in existing.entries) &&
        Object.keys(existing.entries).length >= MAX_PENDING_ENTRIES
      ) {
        accepted = false;
        return;
      }
      existing.entries[key] = entry;
      await writeJsonAtomic(filePath, existing, {
        mode: 0o600,
        trailingNewline: true,
        ensureDirMode: 0o700,
      });
    }),
  );
  return accepted;
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
 * Atomically claim (read and clear) all pending inbound entries.
 * Returns the entries that were present and clears them in a single
 * file-lock-protected operation so that concurrent writers cannot
 * insert entries between the read and the clear — preventing message loss.
 */
export async function claimPendingInboundEntries(stateDir: string): Promise<PendingInboundEntry[]> {
  const filePath = resolveStorePath(stateDir);
  let claimed: PendingInboundEntry[] = [];
  await withInProcessQueue(filePath, () =>
    withFileLock(filePath, PENDING_INBOUND_LOCK_OPTIONS, async () => {
      const existing = await readPendingInboundFile(filePath);
      claimed = Object.values(existing.entries);
      if (claimed.length === 0) {
        return; // nothing to claim
      }
      existing.entries = {};
      await writeJsonAtomic(filePath, existing, {
        mode: 0o600,
        trailingNewline: true,
        ensureDirMode: 0o700,
      });
    }),
  );
  return claimed;
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
  await withInProcessQueue(filePath, () =>
    withFileLock(filePath, PENDING_INBOUND_LOCK_OPTIONS, async () => {
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
    }),
  );
}

/**
 * Clear only the `activeTurns` key, leaving pending inbound `entries` intact.
 */
export async function clearAllActiveTurns(stateDir: string): Promise<void> {
  const filePath = resolveStorePath(stateDir);
  await withInProcessQueue(filePath, () =>
    withFileLock(filePath, PENDING_INBOUND_LOCK_OPTIONS, async () => {
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
    }),
  );
}

/**
 * Upsert an active-turn entry keyed by sessionId.
 * Wrapped in a file lock to prevent concurrent read-modify-write races.
 *
 * Returns false without writing if the tracking map is already at capacity
 * and the entry is genuinely new (not an overwrite of the same sessionId).
 * This prevents evicting live active turns that are still running — those
 * entries are critical for crash-recovery and must not be silently pruned.
 */
export async function writeActiveTurn(stateDir: string, entry: ActiveTurnEntry): Promise<boolean> {
  const filePath = resolveStorePath(stateDir);
  let accepted = true;
  await withInProcessQueue(filePath, () =>
    withFileLock(filePath, PENDING_INBOUND_LOCK_OPTIONS, async () => {
      const existing = await readPendingInboundFile(filePath);
      if (!existing.activeTurns) {
        existing.activeTurns = {};
      }
      // Allow overwrites (same sessionId) even when at capacity.
      // Reject genuinely new entries to avoid evicting live active turns.
      if (
        !(entry.sessionId in existing.activeTurns) &&
        Object.keys(existing.activeTurns).length >= MAX_ACTIVE_TURNS
      ) {
        accepted = false;
        return;
      }
      existing.activeTurns[entry.sessionId] = entry;
      await writeJsonAtomic(filePath, existing, {
        mode: 0o600,
        trailingNewline: true,
        ensureDirMode: 0o700,
      });
    }),
  );
  return accepted;
}

/**
 * Remove an active-turn entry by sessionId.
 * Wrapped in a file lock to prevent concurrent read-modify-write races.
 */
export async function clearActiveTurn(stateDir: string, sessionId: string): Promise<void> {
  const filePath = resolveStorePath(stateDir);
  await withInProcessQueue(filePath, () =>
    withFileLock(filePath, PENDING_INBOUND_LOCK_OPTIONS, async () => {
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
    }),
  );
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

/**
 * Read a single active-turn entry by sessionId.
 * Returns undefined if the entry does not exist.
 * Use this to re-validate a turn before clearing it, avoiding TOCTOU races
 * where a fresh turn with the same sessionId is written after a snapshot is taken.
 */
export async function readActiveTurn(
  stateDir: string,
  sessionId: string,
): Promise<ActiveTurnEntry | undefined> {
  const filePath = resolveStorePath(stateDir);
  const data = await readPendingInboundFile(filePath);
  return data.activeTurns?.[sessionId];
}

async function readPendingInboundFile(filePath: string): Promise<PendingInboundFile> {
  const data = await readJsonFile<PendingInboundFile>(filePath);
  if (data && data.version === 1 && typeof data.entries === "object" && data.entries !== null) {
    return data;
  }
  return { version: 1, entries: {} };
}
