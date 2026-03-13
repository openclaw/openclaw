import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isPidAlive } from "../shared/pid-alive.js";
import { resolveProcessScopedMap } from "../shared/process-scoped-map.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_TTL_MS = 30_000;

export type WorkspaceLockKind = "file" | "dir";

export type WorkspaceLockOptions = {
  kind?: WorkspaceLockKind;
  timeoutMs?: number;
  pollIntervalMs?: number;
  ttlMs?: number;
};

type LockPayload = {
  token: string;
  pid: number;
  createdAt: string;
  expiresAt: string;
  targetPath: string;
  kind: WorkspaceLockKind;
};

type HeldLock = {
  lockPath: string;
  token: string;
  ttlMs: number;
};

export type WorkspaceLockHandle = {
  lockPath: string;
  release: () => Promise<void>;
  refresh: () => Promise<void>;
};

const HELD_WORKSPACE_LOCKS_KEY = Symbol.for("openclaw.workspaceLockManager.heldLocks");
const HELD_WORKSPACE_LOCKS = resolveProcessScopedMap<HeldLock>(HELD_WORKSPACE_LOCKS_KEY);

function lockMapKey(kind: WorkspaceLockKind, normalizedTarget: string): string {
  return `${kind}:${normalizedTarget}`;
}

async function canonicalizePathViaNearestExistingAncestor(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  const suffix: string[] = [];
  let cursor = resolved;

  // Walk upward until we hit an existing ancestor (or filesystem root).
  while (true) {
    try {
      const canonical = await fs.realpath(cursor);
      return suffix.length === 0 ? canonical : path.join(canonical, ...suffix.toReversed());
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return suffix.length === 0 ? resolved : path.join(cursor, ...suffix.toReversed());
      }
      // Preserve unresolved suffix casing so lock identity remains stable before and
      // after path materialization for the same logical target string.
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function normalizeTargetPath(targetPath: string, kind: WorkspaceLockKind): Promise<string> {
  const resolved = path.resolve(targetPath);
  if (kind === "file") {
    return await canonicalizePathViaNearestExistingAncestor(resolved);
  }
  await fs.mkdir(resolved, { recursive: true });
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

async function resolveLockPath(normalizedTarget: string, kind: WorkspaceLockKind): Promise<string> {
  const lockBaseDir = kind === "dir" ? normalizedTarget : path.join(os.tmpdir(), "openclaw");
  const lockDir = path.join(lockBaseDir, ".openclaw.workspace-locks");
  const digest = createHash("sha256")
    .update(`${kind}:${normalizedTarget}`)
    .digest("hex")
    .slice(0, 24);
  return path.join(lockDir, `${kind}-${digest}.lock`);
}

function isTimestampExpired(isoTimestamp: string | undefined): boolean {
  if (!isoTimestamp) {
    return false;
  }
  const ts = Date.parse(isoTimestamp);
  return Number.isFinite(ts) && Date.now() >= ts;
}

async function readPayload(lockPath: string): Promise<LockPayload | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (
      typeof parsed.token !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.expiresAt !== "string" ||
      typeof parsed.targetPath !== "string" ||
      (parsed.kind !== "file" && parsed.kind !== "dir")
    ) {
      return null;
    }
    return {
      token: parsed.token,
      pid: parsed.pid,
      createdAt: parsed.createdAt,
      expiresAt: parsed.expiresAt,
      targetPath: parsed.targetPath,
      kind: parsed.kind,
    };
  } catch {
    return null;
  }
}

async function isStaleLock(lockPath: string, ttlMs: number): Promise<boolean> {
  const payload = await readPayload(lockPath);
  if (payload) {
    if (!Number.isFinite(Date.parse(payload.createdAt))) {
      return true;
    }
    if (isTimestampExpired(payload.expiresAt)) {
      return true;
    }
    if (payload.pid && !isPidAlive(payload.pid)) {
      return true;
    }
    return false;
  }

  try {
    const stat = await fs.stat(lockPath);
    return Date.now() - stat.mtimeMs > ttlMs;
  } catch {
    return true;
  }
}

async function refreshLock(mapKey: string, token: string): Promise<void> {
  const held = HELD_WORKSPACE_LOCKS.get(mapKey);
  if (!held || held.token !== token) {
    return;
  }

  const payload = await readPayload(held.lockPath);
  if (!payload || payload.token !== held.token || payload.token !== token) {
    return;
  }

  const now = Date.now();
  const nextPayload: LockPayload = {
    ...payload,
    expiresAt: new Date(now + held.ttlMs).toISOString(),
  };

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(held.lockPath, "r+");
    await handle.truncate(0);
    await handle.writeFile(JSON.stringify(nextPayload), "utf8");
  } catch {
    // Preserve exclusivity on transient write errors; do not delete lock here.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function releaseLock(mapKey: string, token: string): Promise<void> {
  const held = HELD_WORKSPACE_LOCKS.get(mapKey);
  if (!held || held.token !== token) {
    return;
  }

  HELD_WORKSPACE_LOCKS.delete(mapKey);
  const payload = await readPayload(held.lockPath);
  if (!payload || payload.token !== held.token || payload.token !== token) {
    return;
  }
  await fs.rm(held.lockPath, { force: true }).catch(() => undefined);
}

export async function acquireWorkspaceLock(
  targetPath: string,
  options: WorkspaceLockOptions = {},
): Promise<WorkspaceLockHandle> {
  const kind = options.kind ?? "file";
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_TTL_MS);

  const normalizedTarget = await normalizeTargetPath(targetPath, kind);
  const lockPath = await resolveLockPath(normalizedTarget, kind);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const mapKey = lockMapKey(kind, normalizedTarget);

  // Do not allow implicit same-process reentrancy here. Callers must serialize
  // before acquisition (e.g. via per-target queues) so critical sections remain exclusive.

  const startedAt = Date.now();
  const sleep = async (ms: number): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  };

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const handle = await fs.open(lockPath, "wx");
      const now = Date.now();
      const payload: LockPayload = {
        token: `${process.pid}-${now}-${Math.random().toString(16).slice(2)}`,
        pid: process.pid,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
        targetPath: normalizedTarget,
        kind,
      };

      try {
        await handle.writeFile(JSON.stringify(payload), "utf8");
      } catch (writeErr) {
        await handle.close().catch(() => undefined);
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
        throw writeErr;
      }

      await handle.close();
      HELD_WORKSPACE_LOCKS.set(mapKey, { lockPath, token: payload.token, ttlMs });
      return {
        lockPath,
        release: () => releaseLock(mapKey, payload.token),
        refresh: () => refreshLock(mapKey, payload.token),
      };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "EEXIST") {
        throw err;
      }

      if (await isStaleLock(lockPath, ttlMs)) {
        const removed = await fs
          .rm(lockPath, { force: true })
          .then(() => true)
          .catch(() => false);
        if (removed) {
          continue;
        }
      }

      if (Date.now() - startedAt >= timeoutMs) {
        break;
      }
      await sleep(pollIntervalMs);
    }
  }

  throw new Error(`workspace lock timeout for ${normalizedTarget}`);
}

export async function withWorkspaceLock<T>(
  targetPath: string,
  options: WorkspaceLockOptions = {},
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await acquireWorkspaceLock(targetPath, options);
  const ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_TTL_MS);
  const refreshEveryMs = Math.max(100, Math.floor(ttlMs / 2));
  const timer = setInterval(() => {
    void lock.refresh().catch(() => undefined);
  }, refreshEveryMs);
  timer.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(timer);
    await lock.release();
  }
}
